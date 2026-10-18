using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace BetterBitrix;

public static class Installation
{
    public static string DefaultRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"BetterBitrix");
    public static string ExtensionFolder(string root) => Path.Combine(root,"extension");
    public static string DesktopPath(string root) => Path.Combine(root,"Desktop","BetterBitrix.Desktop.exe");
    public static void Extract(Stream stream,string root)
    {
        var destination=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
        using var zip=new ZipArchive(stream,ZipArchiveMode.Read,leaveOpen:true);
        // Validate every path before writing any entry, including directory entries.
        var entries=zip.Entries.Select(entry=>(entry,target:Path.GetFullPath(Path.Combine(destination,entry.FullName)))).ToList();
        if(entries.Any(item=>!item.target.StartsWith(destination,StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException("Некорректный путь в установочном архиве.");
        foreach(var (entry,target) in entries)
        {
            if(string.IsNullOrEmpty(entry.Name)){Directory.CreateDirectory(target);continue;}
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);entry.ExtractToFile(target,overwrite:true);
        }
        if(!File.Exists(DesktopPath(root)) || !File.Exists(Path.Combine(root,"NativeHost","BetterBitrix.NativeHost.exe"))) throw new InvalidDataException("В сборке отсутствуют файлы приложения.");
        var manifest=System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(ExtensionFolder(root),"manifest.json")));
        var key=Convert.FromBase64String(manifest.RootElement.GetProperty("key").GetString()!);
        var hash=System.Security.Cryptography.SHA256.HashData(key);
        var id=string.Concat(hash.Take(16).SelectMany(value=>new[]{(char)('a'+(value>>4)),(char)('a'+(value&15))}));
        if(id!=ExtensionIdentity.Id) throw new InvalidDataException("Расширение не соответствует этой сборке приложения.");
        WriteHostManifest(root);
    }
    public static void WriteHostManifest(string root)
    {
        var hostDir=Path.Combine(root,"NativeHost");Directory.CreateDirectory(hostDir);
        File.WriteAllText(Path.Combine(hostDir,"com.betterbitrix.desktop.json"),Protocol.Encode(new
        {
            name="com.betterbitrix.desktop",description="BetterBitrix desktop browser bridge",
            path=Path.GetFullPath(Path.Combine(hostDir,"BetterBitrix.NativeHost.exe")),type="stdio",
            allowed_origins=new[]{ $"chrome-extension://{ExtensionIdentity.Id}/" }
        }));
    }
    public static void Register(string root,bool autoStart)
    {
        var manifest=Path.GetFullPath(Path.Combine(root,"NativeHost","com.betterbitrix.desktop.json"));
        foreach(var browser in new[]{@"Google\Chrome",@"Microsoft\Edge"})
        {
            using var key=Registry.CurrentUser.CreateSubKey($@"Software\{browser}\NativeMessagingHosts\com.betterbitrix.desktop");
            key.SetValue("",manifest);
        }
        using(var run=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
        {
            if(autoStart) run.SetValue("BetterBitrix",$"\"{DesktopPath(root)}\" --background");
            else run.DeleteValue("BetterBitrix",false);
        }
        object? shell=null,shortcut=null;
        try
        {
            var type=Type.GetTypeFromProgID("WScript.Shell")!;
            shell=Activator.CreateInstance(type)!;
            dynamic automation=shell;
            shortcut=automation.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"BetterBitrix.lnk"));
            dynamic link=shortcut;link.TargetPath=DesktopPath(root);link.Arguments="--open";link.WorkingDirectory=Path.GetDirectoryName(DesktopPath(root));link.Save();
        }
        finally {if(shortcut is not null)Marshal.FinalReleaseComObject(shortcut);if(shell is not null)Marshal.FinalReleaseComObject(shell);}
    }
    public static bool IsRunning()
    {
        try {using var mutex=Mutex.OpenExisting(@"Local\"+Protocol.PipeName);return true;}
        catch(WaitHandleCannotBeOpenedException){return false;}
    }
    public static void Launch(string root) => Process.Start(new ProcessStartInfo(DesktopPath(root),"--background"){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Hidden});
}
