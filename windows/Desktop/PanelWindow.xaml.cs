using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Button = System.Windows.Controls.Button;
using Brushes = System.Windows.Media.Brushes;

namespace BetterBitrix;

public partial class PanelWindow : Window
{
    private readonly App app;
    private bool filling;
    private long? settingsUid;
    private string meetingKey = "";
    private string uiError = "";
    private bool pairing;
    private bool displayedCalendarCurrent;
    public PanelWindow(App app)
    {
        this.app = app;InitializeComponent();
        Closing += HideOnClose;
        Update();
    }
    private void HideOnClose(object? sender, CancelEventArgs args) { args.Cancel = true;Hide(); }
    public void ShowNearTray()
    {
        var area = SystemParameters.WorkArea;
        Width = Math.Min(410, area.Width);Height = Math.Min(570, area.Height - 16);
        Left = area.Right - Width - 8;Top = area.Bottom - Height - 8;
        Show();Activate();Update();
    }
    public void ShowSettings()
    {
        SettingsPane.Visibility = Visibility.Visible;MeetingsPane.Visibility = Visibility.Collapsed;
        settingsUid = null;FillSettings();
    }
    public void ShowMeetings()
    {
        MeetingsPane.Visibility = Visibility.Visible;SettingsPane.Visibility = Visibility.Collapsed;
        if (app.Bridge.Online) _ = Run("meetings");else Update();
    }
    public void Update()
    {
        var bridge = app.Bridge;var state = bridge.State;var online = bridge.Online;var allowed = bridge.Available;
        if (pairing && online) { pairing = false;uiError = ""; }
        ConnectionLabel.Text = bridge.ConnectionText;
        PortalButton.Visibility = online ? Visibility.Collapsed : Visibility.Visible;
        PrimaryButton.IsEnabled = allowed && state!.CanPrimary;
        PauseButton.Visibility = state?.Timer is { Status: "running" or "paused" } ? Visibility.Visible : Visibility.Collapsed;
        PauseButton.IsEnabled = allowed && state!.CanPause;
        PauseButton.Content = state?.Timer?.Status == "paused" ? "Продолжить" : "Пауза";
        var task = state?.Timer?.Task ?? state?.Selected;
        TaskLabel.Text = task?.ToString() ?? "Выберите задачу в настройках";
        StatusLabel.Text = uiError.Length > 0 ? uiError : bridge.Uncertain ? "Подтверждение записи потеряно. Сначала проверьте журнал времени в задаче Bitrix." : state?.Status ?? "";
        UncertainButton.Visibility = bridge.Uncertain ? Visibility.Visible : Visibility.Collapsed;
        UncertainButton.IsEnabled = online && !bridge.Busy;
        ResolvePane.Visibility = state?.Pending == true ? Visibility.Visible : Visibility.Collapsed;
        QuickButton.IsEnabled = allowed && state!.CanQuickAdd;
        ConfigureButton.IsEnabled = allowed && state!.CanConfigure;
        CancelButton.Visibility = state?.CanCancel == true ? Visibility.Visible : Visibility.Collapsed;
        CancelButton.IsEnabled = allowed;
        TaskSelect.IsEnabled = allowed && state!.CanChangeTask;
        CurrentButton.IsEnabled = allowed && state!.CanChangeTask;
        CollectButton.IsEnabled = allowed;
        ZoneInput.IsEnabled = allowed && state!.CanChangeTimeZone;
        DailyInput.IsEnabled = allowed;ShowAllCheck.IsEnabled = allowed;SaveButton.IsEnabled = allowed;
        TrayButtonsCheck.IsChecked = app.Settings.TrayButtons;AutoStartCheck.IsChecked = LocalSettings.AutoStart;
        if (settingsUid != state?.Uid) {settingsUid = null;FillSettings();}
        var current = state?.MeetingsCurrent == true;
        displayedCalendarCurrent = current;
        var key = Protocol.Encode(new { online, current, uid = state?.Uid, state?.Meetings, state?.MeetingsStatus, state?.MeetingsError, state?.MeetingsCached });
        if (key != meetingKey)
        {
            meetingKey = key;MeetingList.Children.Clear();
            var meetings = current ? state!.Meetings : [];
            MeetingsHint.Text = !online ? current ? "Сохранённые созвоны на сегодня. Изменения появятся после открытия Bitrix." : "На сегодня нет сохранённого списка. Откройте Bitrix для обновления." : state!.MeetingsStatus == "error" ? state.MeetingsError : state.MeetingsStatus == "idle" ? "Нажмите «Обновить»." : meetings.Count == 0 ? "На сегодня созвонов нет." : "";
            if (online && state!.MeetingsCached) MeetingsHint.Text = state.MeetingsError.Length > 0 ? state.MeetingsError + " Показан сохранённый список." : "Показан сохранённый список, пока календарь обновляется.";
            foreach (var meeting in meetings)
            {
                MeetingList.Children.Add(CreateMeetingButton(meeting));
            }
        }
        UpdateClock();
    }
    public static Button CreateMeetingButton(Meeting meeting)
    {
        var label = new StackPanel();
        label.Children.Add(new TextBlock { Text = $"{meeting.Time} · {meeting.Provider}", TextWrapping = TextWrapping.Wrap, Foreground = Brushes.SlateGray, FontSize = 12 });
        label.Children.Add(new TextBlock { Text = meeting.Title, TextWrapping = TextWrapping.Wrap, FontWeight = FontWeights.SemiBold });
        var button = new Button { Content = label, HorizontalContentAlignment = System.Windows.HorizontalAlignment.Stretch, IsEnabled = meeting.Url.Length > 0 };
        button.Click += (_, _) => Links.Open(meeting.Url);
        return button;
    }
    public void UpdateClock()
    {
        var state = app.Bridge.State;
        if (MeetingsPane.Visibility == Visibility.Visible && displayedCalendarCurrent != (state?.MeetingsCurrent == true)) { Update();return; }
        PrimaryButton.Content = app.Bridge.Busy ? "Выполняю…" : state?.Timer is { } timer ? $"Завершить · {timer.Clock}" : state?.DayDone == true ? "✓ Рабочий день завершён" : "Начать рабочий день";
        // Stale snapshots may keep the clock visible, but actions must be disabled.
        if (!app.Bridge.Online) UpdateOfflineButtons();
    }
    private void UpdateOfflineButtons()
    {
        PrimaryButton.IsEnabled = PauseButton.IsEnabled = QuickButton.IsEnabled = ConfigureButton.IsEnabled = false;
        TaskSelect.IsEnabled = CurrentButton.IsEnabled = CollectButton.IsEnabled = SaveButton.IsEnabled = false;
        ZoneInput.IsEnabled = DailyInput.IsEnabled = ShowAllCheck.IsEnabled = CancelButton.IsEnabled = false;
        ConnectionLabel.Text = app.Bridge.ConnectionText;
    }
    private void FillSettings()
    {
        var state = app.Bridge.State;
        if (state?.Uid is null) { filling = true;TaskSelect.ItemsSource = null;DailyInput.Text = "";ZoneInput.Text = "auto";ShowAllCheck.IsChecked = false;filling = false;return; }
        filling = true;
        TaskSelect.ItemsSource = state.Tasks;
        TaskSelect.SelectedItem = state.Tasks.FirstOrDefault(task => task.Id == state.Selected?.Id);
        DailyInput.Text = state.DailyUrl;ZoneInput.Text = state.TimeZone;ShowAllCheck.IsChecked = state.ShowAllMeetings;
        ZoneHint.Text = $"Новый день в 00:00 · {state.ResolvedTimeZone}";
        settingsUid = state.Uid;filling = false;
    }
    private async Task Run(string command, object? parameters = null, bool refill = false)
    {
        uiError = "";pairing = false;
        try { await app.Bridge.Command(command, parameters);if (refill) FillSettings(); }
        catch (Exception error) { uiError = error.Message; }
        Update();
    }
    private void Primary_Click(object sender, RoutedEventArgs e) => _ = Run(app.Bridge.State?.Timer is null ? "start" : "finish");
    private void Pause_Click(object sender, RoutedEventArgs e) => _ = Run("pause");
    private void Meetings_Click(object sender, RoutedEventArgs e) => ShowMeetings();
    private void RefreshMeetings_Click(object sender, RoutedEventArgs e) => _ = Run("meetings");
    private void Settings_Click(object sender, RoutedEventArgs e)
    {
        if (SettingsPane.Visibility == Visibility.Visible) SettingsPane.Visibility = Visibility.Collapsed;else ShowSettings();
    }
    private void Daily_Click(object sender, RoutedEventArgs e)
    {
        if (app.Bridge.State?.DailyUrl is { Length: > 0 } url) Links.Open(url);else ShowSettings();
    }
    private void Portal_Click(object sender, RoutedEventArgs e) => Links.OpenPortal();
    private void InstallBridge_Click(object sender, RoutedEventArgs e) => Links.OpenLocalScript(app.Bridge.BaseUrl + "/BetterBitrixPortable.user.js");
    private void Pair_Click(object sender, RoutedEventArgs e)
    {
        try { uiError = "Откроется Bitrix. Разрешите мосту Tampermonkey доступ к 127.0.0.1, если он спросит. Связывание действует 2 минуты.";pairing = true;Links.Open(app.Bridge.BeginPairing()); }
        catch (Exception error) { uiError = error.Message; }
        Update();
    }
    private void Uncertain_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.MessageBox.Show("Вы проверили журнал времени в задаче Bitrix? Если результат остаётся неопределённым, нажмите «Нет». При наличии незавершённой записи используйте кнопки «Проверил: записано / записи нет» ниже.", "Проверка записи", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        try { app.Bridge.AcknowledgeUncertain(); } catch (Exception error) { uiError = error.Message; }
        Update();
    }
    private void TrayButtons_Click(object sender, RoutedEventArgs e) {app.Settings.TrayButtons=TrayButtonsCheck.IsChecked==true;app.UpdateTrayButtons();}
    public void ShowError(string text) {uiError=text;Update();}
    private void AutoStart_Click(object sender, RoutedEventArgs e)
    {
        try { LocalSettings.SetAutoStart(AutoStartCheck.IsChecked == true); }
        catch (Exception error) {uiError = error.Message;Update();}
    }
    private void Collect_Click(object sender, RoutedEventArgs e) => _ = Run("discover", refill: true);
    private void Current_Click(object sender, RoutedEventArgs e) => _ = Run("currentTask", refill: true);
    private void OpenTask_Click(object sender, RoutedEventArgs e)
    {
        if (app.Bridge.State is { Uid: long uid, Selected: { } task }) Links.OpenTask(uid, task.Id);
    }
    private void TaskSelect_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (!filling && TaskSelect.SelectedItem is PortalTask task) _ = Run("selectTask", new { taskId = task.Id });
    }
    private void Save_Click(object sender, RoutedEventArgs e) => _ = Run("settings", new { dailyUrl = DailyInput.Text, timeZone = ZoneInput.Text.Trim(), showAllMeetings = ShowAllCheck.IsChecked == true }, true);
    private void Configure_Click(object sender, RoutedEventArgs e) => _ = Run("configure");
    private void Cancel_Click(object sender, RoutedEventArgs e) => _ = Run("cancel");
    private void Quick_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.MessageBox.Show("Записать 8 часов в выбранную задачу за сегодня?", "BetterBitrix", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes) _ = Run("quickAdd");
    }
    private void Resolve(bool exists)
    {
        var text = exists ? "Вы проверили журнал Bitrix и нашли запись за этот день?" : "Вы проверили журнал Bitrix и убедились, что запись за этот день отсутствует? Это разрешит повторную отправку.";
        if (System.Windows.MessageBox.Show(text, "Проверка результата", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes) _ = Run("resolve", new { exists, verified = true });
    }
    private void Exists_Click(object sender, RoutedEventArgs e) => Resolve(true);
    private void Absent_Click(object sender, RoutedEventArgs e) => Resolve(false);
}
