using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace BetterBitrix;

public sealed class LocalSettings
{
    private static readonly string FilePath = Path.Combine(PortableData.DirectoryPath, "settings.json");
    public bool TrayButtons { get; set; } = true;
    public static LocalSettings Load()
    {
        try { return Protocol.Decode<LocalSettings>(File.ReadAllText(FilePath)) ?? new(); }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException or UnauthorizedAccessException) { return new(); }
    }
    public void Save() => PortableData.Save(FilePath, this);
    public static bool AutoStart
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            return key?.GetValue("BetterBitrixPortable") as string == StartupCommand;
        }
    }
    public static void SetAutoStart(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) key.SetValue("BetterBitrixPortable", StartupCommand);
        else key.DeleteValue("BetterBitrixPortable", false);
    }
    private static string StartupCommand => $"\"{Environment.ProcessPath}\" --background";
}
public static class Links
{
    public const string Portal = "https://b24.entgld.com/";
    public static void OpenPortal() => Open(Portal);
    public static void OpenLocalScript(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.AbsolutePath != "/BetterBitrixPortable.user.js") return;
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
    public static void OpenTask(long uid, long id) => Open($"{Portal}company/personal/user/{uid}/tasks/task/view/{id}/");
    public static void Open(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo)) return;
        var host = uri.Host.ToLowerInvariant();
        if (!(host == "b24.entgld.com" || host == "zoom.us" || host.EndsWith(".zoom.us") || host == "teams.microsoft.com" || host == "teams.live.com" || host == "teams.cloud.microsoft")) return;
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
