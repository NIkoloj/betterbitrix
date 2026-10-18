using System.Windows;

namespace BetterBitrix;

public partial class App : System.Windows.Application
{
    private Mutex? singleInstance;
    private TrayController? tray;
    public BridgeService Bridge { get; } = new();
    public LocalSettings Settings { get; } = LocalSettings.Load();
    private PanelWindow? panel;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        singleInstance = new Mutex(true, @"Local\" + Protocol.PipeName, out var created);
        if (!created) { Shutdown(); return; }
        panel = new PanelWindow(this);
        tray = new TrayController(this);
        Bridge.Changed += () => Dispatcher.InvokeAsync(() =>
        {
            panel.Update();tray.Update();
        });
        Bridge.Start();
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += (_, _) => { panel.UpdateClock();tray.Update(); };
        timer.Start();
        if (e.Args.Contains("--open") || (!Bridge.Paired && !e.Args.Contains("--background"))) ShowSettings();
    }
    public void ShowPanel() { panel!.ShowNearTray(); }
    public void UpdateTrayButtons()
    {
        Settings.Save();tray?.Update();
    }
    public void ShowMeetings() { ShowPanel();panel!.ShowMeetings(); }
    public void ShowSettings() { ShowPanel();panel!.ShowSettings(); }
    public void OpenDaily()
    {
        if(Bridge.State?.DailyUrl is {Length:>0} url) Links.Open(url);else ShowSettings();
    }
    public async void QuickTimerAction()
    {
        var state=Bridge.State;
        if(!Bridge.Available || (state?.Timer is null ? state?.CanPrimary!=true : state.CanPause!=true)) {ShowPanel();return;}
        try {await Bridge.Command(state.Timer is null ? "start" : "pause");}
        catch(Exception error) {panel!.ShowError(error.Message);ShowPanel();}
    }
    protected override void OnExit(ExitEventArgs e)
    {
        Bridge.Dispose();tray?.Dispose();singleInstance?.Dispose();base.OnExit(e);
    }
}
