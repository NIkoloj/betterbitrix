using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace BetterBitrix;

public sealed class PortableSession
{
    public string TokenHash { get; set; } = "";
    public long? Uid { get; set; }
    public PortalState? State { get; set; }
    public bool Uncertain { get; set; }
}
public sealed class Exchange
{
    public string ClientId { get; set; } = "";
    public PortalState? State { get; set; }
    public List<BridgeMessage> Results { get; set; } = [];
}
public sealed class PairRequest
{
    public string Nonce { get; set; } = "";
    public PortalState? State { get; set; }
}
public sealed record BrowserCommand(string Type, string Id, string Command, object Params, long? ExpectedUid);

// Loopback only: no native messaging registration, URL ACL or admin rights.
// Delivered writes are never replayed; ambiguity stays blocked across restarts.
public sealed class BridgeService : IDisposable
{
    private readonly object gate = new();
    private readonly string filePath;
    private readonly PortableSession session;
    private bool storageFault;
    private string savedKey = "";
    private WebApplication? server;
    private string? nonce;
    private DateTimeOffset pairingUntil;
    private DateTimeOffset lastSeen;
    private string owner = "";
    private BrowserCommand? outgoing;
    private TaskCompletionSource<BridgeMessage>? reply;
    private string? requestId;
    private string? requestKind;
    private readonly CancellationTokenSource stop = new();
    public int Port { get; }
    public string BaseUrl => $"http://127.0.0.1:{Port}";
    public PortalState? State => session.State;
    public bool Paired => session.TokenHash.Length > 0;
    public bool Uncertain => session.Uncertain;
    public string Error { get; private set; } = "";
    public bool Busy => reply is not null;
    public bool Online => !storageFault && lastSeen != default && DateTimeOffset.UtcNow - lastSeen < TimeSpan.FromSeconds(8);
    public bool Available => Online && !Busy && !Uncertain;
    public string ConnectionText => Online ? $"Bitrix · пользователь #{State?.Uid}" : Error.Length > 0 ? Error : Paired
        ? "Браузер отключён. Состояние таймера сохранено; связь восстановится при открытии Bitrix."
        : "Установите мост Tampermonkey, затем нажмите «Связать с браузером» в настройках.";
    public event Action? Changed;

    public BridgeService(string? directory = null, int port = 47653)
    {
        Port = port;filePath = Path.Combine(directory ?? PortableData.DirectoryPath, "session.json");
        try { session = PortableData.Load<PortableSession>(filePath) ?? new();if (File.Exists(filePath)) savedKey = SnapshotKey(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            session = new();storageFault = true;Error = $"Не удалось прочитать сохранённое состояние: {error.Message}. Сохраните папку data для восстановления.";
        }
    }
    public void Start() => _ = StartSafely();
    private async Task StartSafely()
    {
        try { await StartAsync(); }
        catch (Exception error) { Error = $"Не удалось открыть локальную связь: {error.Message}";Changed?.Invoke(); }
    }
    public async Task StartAsync()
    {
        if (storageFault) throw new InvalidOperationException(Error);
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [], ContentRootPath = AppContext.BaseDirectory });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Listen(IPAddress.Loopback, Port);
            options.Limits.MaxRequestBodySize = Protocol.MaxMessageBytes;
            options.AddServerHeader = false;
        });
        server = builder.Build();
        server.Use(async (context, next) =>
        {
            if (context.Request.Host.Host != "127.0.0.1") { context.Response.StatusCode = 403;return; }
            context.Response.Headers.CacheControl = "no-store";
            if (context.Request.Method == "POST" && context.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) != true)
            { context.Response.StatusCode = 415;return; }
            await next(context);
        });
        server.MapGet("/BetterBitrixPortable.user.js", () =>
        {
            using var resource = typeof(BridgeService).Assembly.GetManifestResourceStream("BetterBitrixPortable.user.js")!;
            using var reader = new StreamReader(resource);
            return Results.Text(reader.ReadToEnd(), "application/javascript; charset=utf-8");
        });
        server.MapPost("/pair", async (HttpContext context) =>
        {
            var request = await context.Request.ReadFromJsonAsync<PairRequest>(Protocol.Json, stop.Token);
            lock (gate)
            {
                if (nonce is null || DateTimeOffset.UtcNow >= pairingUntil || request?.Nonce != nonce) return Results.Unauthorized();
                if (request.State is not { Protocol: 1, Uid: > 0 } state) return Results.BadRequest();
                if (session.Uid != state.Uid && (session.Uncertain || session.State?.Timer is not null || session.State?.Pending == true))
                {
                    Error = "Сначала завершите таймер и проверьте записи связанного аккаунта Bitrix. Его сохранённое состояние нельзя заменить другим пользователем.";
                    Changed?.Invoke();return Results.Conflict();
                }
                if (Busy) return Results.Conflict();
                PreserveCalendar(state);
                var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
                var old = (session.TokenHash, session.Uid, session.State);
                session.TokenHash = Hash(token);session.Uid = state.Uid;session.State = state;
                try { Save(); }
                catch { (session.TokenHash, session.Uid, session.State) = old;throw; }
                nonce = null;owner = "";lastSeen = default;Error = "";
                Changed?.Invoke();return Results.Json(new { token, uid = state.Uid }, Protocol.Json);
            }
        });
        server.MapPost("/exchange", async (HttpContext context) =>
        {
            var authorization = context.Request.Headers.Authorization.ToString();
            if (!ValidToken(authorization)) return Results.Unauthorized();
            var request = await context.Request.ReadFromJsonAsync<Exchange>(Protocol.Json, stop.Token);
            lock (gate)
            {
                if (!ValidToken(authorization)) return Results.Unauthorized();
                if (request?.State is not { Protocol: 1, Uid: > 0 } state || request.ClientId.Length is < 16 or > 128 || request.Results.Count > 8) return Results.BadRequest();
                if (state.Uid != session.Uid)
                {
                    lastSeen = default;Error = "Пользователь Bitrix изменился. Вернитесь в связанный аккаунт или свяжите его заново.";
                    Changed?.Invoke();return Results.Conflict();
                }
                if (Online && owner.Length > 0 && owner != request.ClientId) return Results.Conflict();
                if (Online && state.ObservedAt < (session.State?.ObservedAt ?? 0)) return Results.Conflict();
                PreserveCalendar(state);
                foreach (var result in request.Results)
                {
                    if (result.Id != requestId || reply is null) continue;
                    session.State = state;
                    if (result.Error is null && requestKind is "finish" or "quickAdd" or "configure" or "resolve") session.Uncertain = false;
                    Save();reply.TrySetResult(result);
                }
                session.State = state;Save();lastSeen = DateTimeOffset.UtcNow;owner = request.ClientId;Error = "";
                var command = outgoing;
                if (command is not null)
                {
                    if (command.Command is "finish" or "quickAdd" or "configure") { session.Uncertain = true;Save(); }
                    outgoing = null;
                }
                Changed?.Invoke();return Results.Json(new { command }, Protocol.Json);
            }
        });
        await server.StartAsync(stop.Token);
        _ = WatchConnection();
    }
    private async Task WatchConnection()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            while (await timer.WaitForNextTickAsync(stop.Token))
            {
                lock (gate)
                {
                    if (!Online && lastSeen != default)
                    {
                        lastSeen = default;owner = "";outgoing = null;
                        reply?.TrySetException(new IOException("Связь прервана. Таймер сохранён. Перед повторной записью проверьте журнал времени в Bitrix."));
                        Changed?.Invoke();
                    }
                }
            }
        }
        catch (OperationCanceledException) { }
    }
    private bool ValidToken(string authorization)
    {
        if (!authorization.StartsWith("Bearer ", StringComparison.Ordinal) || authorization.Length != 71 || session.TokenHash.Length != 64) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Hash(authorization[7..])), Encoding.ASCII.GetBytes(session.TokenHash));
    }
    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    private void PreserveCalendar(PortalState incoming)
    {
        if (incoming.MeetingsStatus == "ready" || session.State is not { MeetingsCurrent: true } cached || cached.Uid != incoming.Uid) return;
        incoming.Meetings = cached.Meetings.Where(item => incoming.ShowAllMeetings || item.Url.Length > 0).ToList();
        incoming.MeetingsDate = cached.MeetingsDate;incoming.MeetingsTimeZone = cached.MeetingsTimeZone;incoming.MeetingsOffsetSeconds = cached.MeetingsOffsetSeconds;
        incoming.MeetingsCached = true;incoming.MeetingsStatus = "ready";
    }
    private string SnapshotKey()
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse(Protocol.Encode(session))!;
        if (node["state"] is System.Text.Json.Nodes.JsonObject snapshot) snapshot.Remove("observedAt");
        return node.ToJsonString();
    }
    private void Save()
    {
        try
        {
            var key = SnapshotKey();if (key == savedKey) return;
            PortableData.Save(filePath, session);savedKey = key;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            storageFault = true;lastSeen = default;Error = "Не удалось сохранить таймер. Перенесите portable-папку в доступное для записи место и перезапустите приложение. " + error.Message;
            reply?.TrySetException(new IOException(Error));Changed?.Invoke();throw;
        }
    }
    public string BeginPairing()
    {
        lock (gate)
        {
            if (server is null || !server.Lifetime.ApplicationStarted.IsCancellationRequested) throw new InvalidOperationException("Локальная связь ещё не готова.");
            if (Busy) throw new InvalidOperationException("Дождитесь выполнения команды.");
            nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));pairingUntil = DateTimeOffset.UtcNow.AddMinutes(2);
            return $"{Links.Portal}#betterbitrix-pair={Port}.{nonce}";
        }
    }
    public void AcknowledgeUncertain()
    {
        lock (gate)
        {
            if (!Online || Busy) throw new InvalidOperationException("Сначала восстановите связь с Bitrix.");
            session.Uncertain = false;Save();Changed?.Invoke();
        }
    }
    public async Task Command(string command, object? parameters = null)
    {
        TaskCompletionSource<BridgeMessage> completion;
        lock (gate)
        {
            if (!Online || Busy || (Uncertain && command is not ("resolve" or "meetings" or "discover")))
                throw new InvalidOperationException(Uncertain ? "Сначала проверьте результат предыдущей записи в журнале Bitrix." : "Откройте Bitrix в браузере. Таймер и ссылки сохранены.");
            completion = new(TaskCreationOptions.RunContinuationsAsynchronously);reply = completion;requestId = Guid.NewGuid().ToString("N");
            requestKind = command;
            outgoing = new("command", requestId, command, parameters ?? new { }, session.Uid);Changed?.Invoke();
        }
        try
        {
            var result = await completion.Task.WaitAsync(TimeSpan.FromSeconds(75), stop.Token);
            if (result.Error is { Length: > 0 } error) throw new InvalidOperationException(error);
        }
        catch (TimeoutException) { throw new InvalidOperationException("Нет подтверждения команды. Проверьте журнал Bitrix перед повтором; автоматического повтора нет."); }
        finally { lock (gate) { outgoing = null;reply = null;requestId = null;Changed?.Invoke(); } }
    }
    public void Dispose()
    {
        stop.Cancel();reply?.TrySetCanceled();
        if (server is not null) _ = server.DisposeAsync();
    }
}
