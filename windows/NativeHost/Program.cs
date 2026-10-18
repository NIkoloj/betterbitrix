using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using BetterBitrix;

// No logging on stdout: Chrome requires an exact length-prefixed byte stream.
// The installer writes this manifest next to the executable, with exact extension IDs.
if (args.Length == 0) return;
try
{
    var manifest = System.Text.Json.JsonDocument.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "com.betterbitrix.desktop.json")));
    var origins = manifest.RootElement.GetProperty("allowed_origins").EnumerateArray();
    if (!origins.Any(item => item.GetString() == args[0])) return;
    using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var pipe = new NamedPipeClientStream(".", Protocol.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
    await pipe.ConnectAsync(cancel.Token);
    using var shutdown = new CancellationTokenSource();
    var input = Console.OpenStandardInput();
    var output = Console.OpenStandardOutput();
    var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
    var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
    var toApp = Task.Run(async () =>
    {
        var header = new byte[4];
        while (!shutdown.IsCancellationRequested)
        {
            await input.ReadExactlyAsync(header, shutdown.Token);
            var length = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (length <= 0 || length > Protocol.MaxMessageBytes) throw new InvalidDataException();
            var payload = new byte[length];
            await input.ReadExactlyAsync(payload, shutdown.Token);
            // Normalize JSON to one line so strings cannot inject pipe messages.
            using var document = System.Text.Json.JsonDocument.Parse(payload);
            await writer.WriteLineAsync(Protocol.Encode(document.RootElement).AsMemory(), shutdown.Token);
        }
    });
    var toBrowser = Task.Run(async () =>
    {
        while (await reader.ReadLineAsync(shutdown.Token) is string line)
        {
            var bytes = Encoding.UTF8.GetBytes(line);
            if (bytes.Length > Protocol.MaxMessageBytes) throw new InvalidDataException();
            var header = new byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
            await output.WriteAsync(header, shutdown.Token);
            await output.WriteAsync(bytes, shutdown.Token);
            await output.FlushAsync(shutdown.Token);
        }
    });
    await Task.WhenAny(toApp, toBrowser);
    shutdown.Cancel();
    // Terminate both pumps even if stdin isn't cancellation-aware on this host.
}
catch (Exception error) when (error is IOException or OperationCanceledException or System.Text.Json.JsonException or UnauthorizedAccessException)
{
    // Browser observes disconnection and reconnects; credentials are never logged.
}
