using System.IO;

namespace BetterBitrix;

// All durable application data lives beside the portable executable.
public static class PortableData
{
    public static string DirectoryPath => Path.Combine(AppContext.BaseDirectory, "data");
    public static T? Load<T>(string path)
    {
        if (!File.Exists(path)) return default;
        // A damaged timer must be reported, rather than silently starting an empty day.
        return Protocol.Decode<T>(File.ReadAllText(path));
    }
    public static void Save<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            var bytes = System.Text.Encoding.UTF8.GetBytes(Protocol.Encode(value));
            file.Write(bytes);file.Flush(true);
        }
        File.Move(temporary, path, true);
    }
}
