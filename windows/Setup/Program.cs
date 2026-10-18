using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;
using BetterBitrix;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();Application.Run(new SetupForm());
    }
}

public sealed class SetupForm : Form
{
    private readonly Button install=new(){Text="Установить",AutoSize=true,Padding=new Padding(18,7,18,7)};
    private readonly Button folder=new(){Text="Открыть папку расширения",AutoSize=true,Enabled=false,Visible=false};
    private readonly Button browser=new(){Text="Открыть расширения браузера",AutoSize=true,Enabled=false,Visible=false};
    private readonly CheckBox autostart=new(){Text="Запускать при входе в Windows",Checked=true,AutoSize=true};
    private readonly ComboBox browserChoice=new(){DropDownStyle=ComboBoxStyle.DropDownList,Width=160,Visible=false};
    private readonly Label message=new(){AutoSize=true,MaximumSize=new Size(515,0)};
    public SetupForm()
    {
        Text="Установка BetterBitrix";ClientSize=new Size(560,430);MinimumSize=new Size(560,430);
        StartPosition=FormStartPosition.CenterScreen;Font=new Font("Segoe UI",10);
        var layout=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(22)};
        layout.Controls.Add(new Label{Text="BetterBitrix",Font=new Font("Segoe UI",20,FontStyle.Bold),AutoSize=true});
        layout.Controls.Add(new Label{Text="Рабочий день, созвоны и дейлик — рядом с часами Windows.",AutoSize=true,MaximumSize=new Size(515,0),Margin=new Padding(0,8,0,16)});
        layout.Controls.Add(autostart);layout.Controls.Add(install);layout.Controls.Add(message);
        browserChoice.Items.AddRange(["Microsoft Edge","Google Chrome"]);browserChoice.SelectedIndex=0;
        layout.Controls.Add(browserChoice);layout.Controls.Add(browser);layout.Controls.Add(folder);
        layout.Controls.Add(new Label{Text="Текущая пилотная сборка: расширение подключается вручную. После публикации в магазине этот шаг заменится кнопкой «Добавить расширение».",AutoSize=true,MaximumSize=new Size(515,0),ForeColor=Color.DimGray,Margin=new Padding(0,12,0,0)});
        Controls.Add(layout);
        install.Click+=async(_,_)=>await Install();
        folder.Click+=(_,_)=>OpenFolder();browser.Click+=(_,_)=>OpenBrowser();
    }
    private async Task Install()
    {
        if(Installation.IsRunning()){MessageBox.Show("Закройте BetterBitrix через меню значка в трее и нажмите «Установить» снова.",Text);return;}
        install.Enabled=false;message.Text="Устанавливаю…";
        var autoStart=autostart.Checked;
        try
        {
            await Task.Run(()=>{
                using var payload=Assembly.GetExecutingAssembly().GetManifestResourceStream("BetterBitrix.Payload.zip") ?? throw new IOException("В установщике отсутствуют файлы приложения.");
                Installation.Extract(payload,Installation.DefaultRoot);Installation.Register(Installation.DefaultRoot,autoStart);
            });
            Installation.Launch(Installation.DefaultRoot);
            install.Text="Установлено";browser.Enabled=folder.Enabled=true;
            browser.Visible=folder.Visible=browserChoice.Visible=true;
            ClientSize=new Size(560,620);
            message.Text="Готово. Осталось подключить браузер:\n1. Нажмите «Открыть расширения браузера».\n2. Включите режим разработчика → «Загрузить распакованное».\n3. Выберите папку, открываемую кнопкой ниже.\n4. Обновите вашу вкладку Bitrix.\n\nПеретащите значки BetterBitrix из меню «^» к часам Windows — они будут постоянно на виду.";
        }
        catch(Exception error){message.Text=$"Не удалось установить: {error.Message}";install.Enabled=true;}
    }
    private void OpenFolder()
    {
        try {Process.Start(new ProcessStartInfo("explorer.exe",Installation.ExtensionFolder(Installation.DefaultRoot)){UseShellExecute=true});}
        catch(Exception error){MessageBox.Show(error.Message,Text);}
    }
    private void OpenBrowser()
    {
        var edge=browserChoice.SelectedIndex==0;
        try {Process.Start(new ProcessStartInfo(edge?"msedge.exe":"chrome.exe",edge?"edge://extensions":"chrome://extensions"){UseShellExecute=true});}
        catch {MessageBox.Show(edge?"Откройте Microsoft Edge и введите edge://extensions в адресной строке.":"Откройте Chrome и введите chrome://extensions в адресной строке.",Text);}
    }
}
