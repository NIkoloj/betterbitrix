using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BetterBitrix;
using Size = System.Windows.Size;

var root = Path.GetFullPath(args[0]);
var output = Path.Combine(root, ".build", "smoke");
Directory.CreateDirectory(output);
var isolated = Path.Combine(output, "portable-" + Guid.NewGuid().ToString("N"));
var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
listener.Start();var port = ((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();
var state = new PortalState { Protocol = 1, Uid = 1178, ObservedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Status = "Готово — связь установлена", CanPrimary = true, CanPause = true,
    Timer = new WorkTimer { Status = "running", StartedAt = DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeMilliseconds(), AccumulatedMs = 1000, Date = "2026-10-05", Task = new PortalTask { Id = 129769, Title = "Проект" } }, DailyUrl = "https://zoom.us/j/123" };
using var bridge = new BridgeService(isolated, port);await bridge.StartAsync();
using var http = new HttpClient { BaseAddress = new Uri(bridge.BaseUrl), Timeout = TimeSpan.FromSeconds(10) };
async Task<HttpResponseMessage> Post(string path, object payload, string? token = null)
{
    using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(Protocol.Encode(payload), Encoding.UTF8, "application/json") };
    if (token is not null) request.Headers.Authorization = new("Bearer", token);
    return await http.SendAsync(request);
}
void Assert(bool condition, string error) { if (!condition) throw new Exception(error); }
var script = await http.GetStringAsync("/BetterBitrixPortable.user.js");
Assert(script.Contains("// ==UserScript==") && script.Contains("GM_xmlhttpRequest") && !script.Contains("secret-csrf"), "Embedded bridge script missing");
Assert((await Post("/pair", new { nonce = "wrong", state })).StatusCode == HttpStatusCode.Unauthorized, "Unsolicited pairing accepted");
Assert((await Post("/exchange", new { state, clientId = new string('a', 32) })).StatusCode == HttpStatusCode.Unauthorized, "Unauthenticated data accepted");
var pairingUrl = bridge.BeginPairing();var nonce = pairingUrl[(pairingUrl.LastIndexOf('.') + 1)..];
using var pair = await Post("/pair", new { nonce, state });Assert(pair.IsSuccessStatusCode, "Pairing rejected");
using var paired = JsonDocument.Parse(await pair.Content.ReadAsStringAsync());var token = paired.RootElement.GetProperty("token").GetString()!;
Assert(token.Length == 64 && !pairingUrl.Contains(token), "Durable token leaked into URL");
Assert((await Post("/pair", new { nonce, state })).StatusCode == HttpStatusCode.Unauthorized, "Pairing nonce replay accepted");
Assert(!File.ReadAllText(Path.Combine(isolated, "session.json")).Contains(token), "Plaintext token stored by desktop");
Assert((await Post("/exchange", new { state, clientId = new string('a', 32) }, new string('F', 64))).StatusCode == HttpStatusCode.Unauthorized, "Forged token accepted");
using (var rebinding = new HttpRequestMessage(HttpMethod.Get, "/BetterBitrixPortable.user.js"))
{
    rebinding.Headers.Host = "attacker.example";
    Assert((await http.SendAsync(rebinding)).StatusCode == HttpStatusCode.Forbidden, "DNS rebinding accepted");
}
using (var form = new HttpRequestMessage(HttpMethod.Post, "/pair") { Content = new StringContent("{}") })
    Assert((await http.SendAsync(form)).StatusCode == HttpStatusCode.UnsupportedMediaType, "Browser form submission accepted");
using (var oversize = new HttpRequestMessage(HttpMethod.Post, "/exchange") { Content = new StringContent(new string('x', Protocol.MaxMessageBytes + 1), Encoding.UTF8, "application/json") })
{
    oversize.Headers.Authorization = new("Bearer", token);
    Assert((await http.SendAsync(oversize)).StatusCode == HttpStatusCode.RequestEntityTooLarge, "Oversized request accepted");
}
const string client = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
async Task<JsonDocument> Exchange(List<BridgeMessage>? results = null)
{
    state.ObservedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    using var response = await Post("/exchange", new { state, clientId = client, results = results ?? [] }, token);
    Assert(response.IsSuccessStatusCode, "Exchange rejected: " + response.StatusCode);
    return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
}
using (await Exchange()) { }
Assert(bridge.Online && bridge.State?.Status == "Готово — связь установлена", "UTF-8 state missing");
var unchangedFile = File.ReadAllText(Path.Combine(isolated, "session.json"));
using (await Exchange()) { }
Assert(File.ReadAllText(Path.Combine(isolated, "session.json")) == unchangedFile, "An unchanged heartbeat rewrote the durable snapshot");
var switchUrl = bridge.BeginPairing();var switchNonce = switchUrl[(switchUrl.LastIndexOf('.') + 1)..];
Assert((await Post("/pair", new { nonce = switchNonce, state = new PortalState { Protocol = 1, Uid = 999 } })).StatusCode == HttpStatusCode.Conflict && bridge.State?.Uid == 1178, "Re-pairing overwrote another user's active timer");
using (var competing = await Post("/exchange", new { state, clientId = new string('b', 32) }, token))
    Assert(competing.StatusCode == HttpStatusCode.Conflict, "Competing tab allowed");
var pause = bridge.Command("pause");
string requestId;
using (var exchange = await Exchange())
{
    var command = exchange.RootElement.GetProperty("command");
    Assert(command.GetProperty("expectedUid").GetInt64() == 1178 && command.GetProperty("command").GetString() == "pause", "Command identity mismatch");
    requestId = command.GetProperty("id").GetString()!;
}
using (var exchange = await Exchange()) Assert(exchange.RootElement.GetProperty("command").ValueKind == JsonValueKind.Null, "Command replayed after lost response");
state.Timer = new WorkTimer { Status = "paused", AccumulatedMs = 3661000 };
using (await Exchange([new BridgeMessage { Type = "result", Id = requestId, State = state }])) { }
await pause;Assert(bridge.State!.Timer!.Clock == "01:01:01", "Reply state not applied");
Console.WriteLine("PASS loopback pairing, one-use nonce, hashed token, authentication, identity lease, size limit and exactly-once delivery");

var finishing = bridge.Command("finish");
using (var exchange = await Exchange()) requestId = exchange.RootElement.GetProperty("command").GetProperty("id").GetString()!;
Assert(bridge.Uncertain, "Write intent was not persisted before delivery");
// Stop the heartbeat, as if the tab/browser closed during a submission.
try { await finishing;throw new Exception("Lost browser did not fail command"); } catch (IOException) { }
Assert(!bridge.Online && bridge.State!.Timer!.Clock == "01:01:01", "Cached timer lost when browser closed");
using (var restarted = new BridgeService(isolated, port + 1))
{
    Assert(restarted.Paired && restarted.Uncertain && restarted.State?.Uid == 1178 && restarted.State.Timer?.Clock == "01:01:01", "Durable state lost after process restart");
    Assert(restarted.State!.DailyUrl == "https://zoom.us/j/123", "Cached daily lost");
}
using (var reconnected = await Exchange()) Assert(reconnected.RootElement.GetProperty("command").ValueKind == JsonValueKind.Null, "Write replayed on reconnect");
try { await bridge.Command("quickAdd");throw new Exception("Ambiguous submission did not block retry"); } catch (InvalidOperationException) { }
var read = bridge.Command("meetings");
using (var exchange = await Exchange()) requestId = exchange.RootElement.GetProperty("command").GetProperty("id").GetString()!;
using (await Exchange([new BridgeMessage { Type = "result", Id = requestId }])) { }
await read;Assert(bridge.Uncertain, "Calendar read cleared uncertain write");
bridge.AcknowledgeUncertain();Assert(bridge.Available, "Verified acknowledgement did not restore access");
state.Uid = 999;
Assert((await Post("/exchange", new { state, clientId = client }, token)).StatusCode == HttpStatusCode.Conflict && bridge.State?.Uid == 1178 && !bridge.Online, "Account switch replaced bound snapshot");
state.Uid = 1178;using (await Exchange()) { }
Assert(bridge.Online, "Bound account failed to reconnect");
// Disk persistence of a running clock uses its absolute start timestamp, not tick counts.
state.Timer = new WorkTimer { Status = "running", StartedAt = DateTimeOffset.UtcNow.AddHours(-2).ToUnixTimeMilliseconds(), AccumulatedMs = 1000 };
using (await Exchange()) { }
using (var restarted = new BridgeService(isolated, port + 1))
{
    Assert(restarted.State!.Timer!.Clock.StartsWith("02:00:"), "Running timer did not include offline elapsed time");
    Assert(!restarted.Online, "Cached snapshot incorrectly treated as live");
    try { await restarted.Command("finish");throw new Exception("Offline submission allowed"); } catch (InvalidOperationException) { }
}
state.MeetingsDate = "2000-01-01";state.MeetingsTimeZone = "Europe/Moscow";Assert(!state.MeetingsCurrent, "Old calendar considered current");
state.MeetingsDate = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Moscow")).ToString("yyyy-MM-dd");
Assert(state.MeetingsCurrent, "Current calendar rejected");
state.MeetingsStatus = "ready";state.Meetings = [new Meeting { Title = "Созвон", Url = "https://zoom.us/j/123" }];using (await Exchange()) { }
state.MeetingsStatus = "loading";state.Meetings = [];state.MeetingsDate = "";using (await Exchange()) { }
Assert(bridge.State!.MeetingsCurrent && bridge.State.MeetingsCached && bridge.State.Meetings.Count == 1, "Reloading calendar lost the cached links");
var damaged = Path.Combine(output, "damaged-" + Guid.NewGuid().ToString("N"));Directory.CreateDirectory(damaged);
File.WriteAllText(Path.Combine(damaged, "session.json"), "{");
using (var corrupt = new BridgeService(damaged, port + 1))
{
    try { await corrupt.StartAsync();throw new Exception("Damaged state started an empty session"); } catch (InvalidOperationException) { }
    Assert(!corrupt.Online && File.ReadAllText(Path.Combine(damaged, "session.json")) == "{", "Damaged state was silently overwritten");
}
Console.WriteLine("PASS browser closure/reconnect, cached timer/daily, process restart, offline elapsed time, uncertain-write recovery and calendar rollover");
Console.WriteLine("PASS unchanged heartbeats avoid disk writes, active account cannot be replaced, cached calendar survives refresh and damaged data stays preserved");

Exception? renderError = null;
var render = new Thread(() =>
{
    try
    {
        var app = new App();app.InitializeComponent();
        var panel = new PanelWindow(app);panel.ShowSettings();
        Render(panel, "panel-settings.png", 410, 570);
        ((System.Windows.Controls.StackPanel)panel.FindName("SettingsPane")).Visibility = Visibility.Collapsed;
        ((System.Windows.Controls.StackPanel)panel.FindName("MeetingsPane")).Visibility = Visibility.Visible;
        var list = (System.Windows.Controls.StackPanel)panel.FindName("MeetingList");
        foreach (var title in new[] { "Еженедельный созвон команды — планирование задач на следующую неделю", new string('W', 180), "Без ссылки — обсуждение проекта" })
            list.Children.Add(PanelWindow.CreateMeetingButton(new Meeting { Title = title, Time = "10:00–10:30", Provider = "Microsoft Teams", Url = title.StartsWith("Без") ? "" : "https://teams.microsoft.com/l/meetup-join/123" }));
        foreach (var width in new[] { 370, 410 })
        {
            Render(panel, $"panel-meetings-{width}.png", width, 570);
            foreach (System.Windows.Controls.Button button in list.Children)
            {
                var label = (System.Windows.Controls.StackPanel)button.Content;
                Assert(button.ActualWidth <= list.ActualWidth && label.ActualWidth <= button.ActualWidth - 20, "Calendar content escaped its card");
                Assert(label.Children.OfType<System.Windows.Controls.TextBlock>().All(text => text.ActualWidth <= label.ActualWidth + 1), "Meeting text overflowed");
            }
        }
        if(app.Windows.OfType<Window>().Any(window=>window.IsVisible)) throw new Exception("A floating window is visible without a user click");
        var trayState=new PortalState { Protocol=1,Uid=1178,CanPause=true,Timer=new WorkTimer{Status="paused",AccumulatedMs=13338000},MeetingsStatus="ready",Meetings=[new Meeting(),new Meeting()] };
        foreach(var light in new[]{true,false})
        {
            using var canvas=new System.Drawing.Bitmap(200,40);
            using var drawing=System.Drawing.Graphics.FromImage(canvas);
            drawing.Clear(light?System.Drawing.Color.FromArgb(245,245,245):System.Drawing.Color.FromArgb(32,32,32));
            foreach(var action in Enum.GetValues<TrayAction>())
            {
                using var image=TrayArtwork.Render(action,trayState,true,false,light);
                drawing.DrawImageUnscaled(image,4+(int)action*40,4);
            }
            canvas.Save(Path.Combine(output,light?"tray-light.png":"tray-dark.png"));
        }
        using(var icon=TrayArtwork.Create(TrayAction.Timer,trayState,true,false,false)) if(icon.Handle==IntPtr.Zero) throw new Exception("Invalid native icon handle");
        trayState.Meetings=Enumerable.Range(0,9).Select(_=>new Meeting()).ToList();
        using var nine=TrayArtwork.Render(TrayAction.Calls,trayState,true,false,true);
        trayState.Meetings.AddRange([new Meeting(),new Meeting()]);
        using var eleven=TrayArtwork.Render(TrayAction.Calls,trayState,true,false,true);
        if(Enumerable.Range(0,32).All(x=>Enumerable.Range(0,32).All(y=>nine.GetPixel(x,y)==eleven.GetPixel(x,y)))) throw new Exception("Two-digit meeting count not rendered");
        if(!TrayController.Tooltip(TrayAction.Timer,trayState,true,false).Contains("03:42:18")) throw new Exception("Full timer not present in tooltip");
        using(var tray=new TrayController(app))
        {
            if(tray.RegisteredIconCount!=5) throw new Exception("Shell did not register all five native tray icons");
            tray.Dispose();if(tray.RegisteredIconCount!=0) throw new Exception("Shell icons were not removed");
        }
        app.Shutdown();
    }
    catch (Exception error) { renderError = error; }
});
void Render(Window window, string fileName, double width, double height)
{
    window.Width = width;window.Height = height;
    var content = (FrameworkElement)window.Content;
    content.Measure(new Size(width, height));content.Arrange(new Rect(0,0,width,height));content.UpdateLayout();
    var image = new RenderTargetBitmap((int)width, (int)height, 96, 96, PixelFormats.Pbgra32);
    var background = new DrawingVisual();
    using (var drawing = background.RenderOpen()) drawing.DrawRectangle(window.Background, null, new Rect(0,0,width,height));
    image.Render(background);image.Render(content);
    var encoder = new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));
    using var stream = File.Create(Path.Combine(output, fileName));encoder.Save(stream);
}
render.SetApartmentState(ApartmentState.STA);render.Start();render.Join();
if (renderError is not null) throw renderError;
Console.WriteLine("PASS no floating window; five native tray icons registered/removed, full-time tooltip, light/dark artwork and portable settings layout");

using var archive = System.IO.Compression.ZipFile.OpenRead(Path.Combine(root,".build","BetterBitrixPortable-0.3.2-win-x64.zip"));
Assert(archive.Entries.Any(entry => entry.FullName == "BetterBitrix.Desktop.exe"), "Portable executable absent");
Assert(archive.Entries.Any(entry => entry.FullName == "BetterBitrixPortable.user.js"), "Companion script absent");
Assert(!archive.Entries.Any(entry => entry.FullName.Contains("Setup") || entry.FullName.Contains("NativeHost") || entry.FullName.Contains("session.json") || entry.FullName.StartsWith("data/") || entry.FullName.Contains("install.ps1")), "Portable package includes installer/private data");
Console.WriteLine("PASS portable archive contains executable and companion, no installer, host registration or user session");
