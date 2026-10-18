using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace BetterBitrix;

public enum TrayAction { Timer, Pause, Calls, Daily, Settings }

public static class TrayArtwork
{
    // Exact pixel digits stay readable when Windows reduces the icon to 16 px.
    private static readonly string[] Digits = [
        "01110/10001/10011/10101/11001/10001/01110", "00100/01100/00100/00100/00100/00100/01110",
        "01110/10001/00001/00010/00100/01000/11111", "11110/00001/00001/01110/00001/00001/11110",
        "00010/00110/01010/10010/11111/00010/00010", "11111/10000/10000/11110/00001/00001/11110",
        "01110/10000/10000/11110/10001/10001/01110", "11111/00001/00010/00100/01000/01000/01000",
        "01110/10001/10001/01110/10001/10001/01110", "01110/10001/10001/01111/00001/00001/01110"
    ];
    public static Bitmap Render(TrayAction action, PortalState? state, bool online, bool busy, bool light)
    {
        var bitmap = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var drawing = Graphics.FromImage(bitmap);
        drawing.Clear(Color.Transparent);drawing.ScaleTransform(2,2);
        var foreground = online ? light ? Color.FromArgb(32,48,64) : Color.White : Color.FromArgb(130,140,150);
        using var pen = new Pen(foreground, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        using var ink = new SolidBrush(foreground);
        if (action == TrayAction.Timer)
        {
            var clock = state?.Timer?.Clock ?? "00:00:00";
            var parts = clock.Split(':');
            var hours = int.TryParse(parts[0], out var value) ? Math.Min(99, value).ToString("00") : "00";
            Number(drawing, ink, hours, 1, 0);Number(drawing, ink, parts.ElementAtOrDefault(1) ?? "00", 1, 8);
            using var indicator = new SolidBrush(!online ? Color.Gray : busy || state?.Pending == true ? Color.FromArgb(231,160,40) : state?.DayDone == true ? Color.FromArgb(42,160,90) : state?.Timer?.Status == "paused" ? Color.FromArgb(231,160,40) : Color.FromArgb(13,131,221));
            drawing.FillRectangle(indicator, 14, 1, 1, 14);
            return bitmap;
        }
        drawing.SmoothingMode = SmoothingMode.AntiAlias;
        switch (action)
        {
            case TrayAction.Pause:
                if (state?.Timer?.Status == "running") { drawing.FillRectangle(ink,4,3,3,10);drawing.FillRectangle(ink,9,3,3,10); }
                else drawing.FillPolygon(ink,[new PointF(4,2),new PointF(13,8),new PointF(4,14)]);
                break;
            case TrayAction.Calls:
                drawing.DrawRectangle(pen,2,4,12,10);drawing.DrawLine(pen,2,7,14,7);
                drawing.DrawLine(pen,5,2,5,5);drawing.DrawLine(pen,11,2,11,5);
                if (state?.MeetingsStatus == "ready" && (online || state.MeetingsCurrent))
                {
                    drawing.SmoothingMode=SmoothingMode.None;
                    var count=Math.Min(99,state.Meetings.Count).ToString();
                    Number(drawing,ink,count,count.Length==1?5:3,8);
                }
                break;
            case TrayAction.Daily:
                drawing.DrawRectangle(pen,1.5f,4,8,8);drawing.DrawPolygon(pen,[new PointF(10,6),new PointF(14,3),new PointF(14,13),new PointF(10,10)]);
                break;
            case TrayAction.Settings:
                drawing.DrawEllipse(pen,4,4,8,8);drawing.DrawEllipse(pen,6.5f,6.5f,3,3);
                for (var i=0;i<8;i++) { var a=i*Math.PI/4;drawing.DrawLine(pen,(float)(8+5*Math.Cos(a)),(float)(8+5*Math.Sin(a)),(float)(8+7*Math.Cos(a)),(float)(8+7*Math.Sin(a))); }
                break;
        }
        return bitmap;
    }
    private static void Number(Graphics drawing, Brush ink, string number, int left, int top)
    {
        foreach (var character in number)
        {
            var rows=Digits[character-'0'].Split('/');
            for (var y=0;y<7;y++) for (var x=0;x<5;x++) if(rows[y][x]=='1') drawing.FillRectangle(ink,left+x,top+y,1,1);
            left+=6;
        }
    }
    public static Icon Create(TrayAction action, PortalState? state, bool online, bool busy, bool light)
    {
        using var bitmap=Render(action,state,online,busy,light);
        var handle=bitmap.GetHicon();
        try { using var borrowed=Icon.FromHandle(handle);return (Icon)borrowed.Clone(); }
        finally { DestroyIcon(handle); }
    }
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
}
