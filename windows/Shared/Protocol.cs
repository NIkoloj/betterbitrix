using System.Security.Principal;
using System.Text.Json;

namespace BetterBitrix;

public static class Protocol
{
    public const int MaxMessageBytes = 1024 * 1024;
    public static string PipeName => "BetterBitrix.Desktop." + WindowsIdentity.GetCurrent().User!.Value;
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static string Encode<T>(T value) => JsonSerializer.Serialize(value, Json);
    public static T? Decode<T>(string value) => JsonSerializer.Deserialize<T>(value, Json);
}

public sealed class PortalTask
{
    public long Id { get; set; }
    public string Title { get; set; } = "";
    public override string ToString() => $"#{Id} · {Title}";
}
public sealed class WorkTimer
{
    public string Status { get; set; } = "idle";
    public double? StartedAt { get; set; }
    public double AccumulatedMs { get; set; }
    public PortalTask? Task { get; set; }
    public string Date { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore]
    public string Clock
    {
        get
        {
            var ms = Math.Max(0, AccumulatedMs);
            if (Status == "running" && StartedAt is double at)
                ms += Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - at);
            var time = TimeSpan.FromMilliseconds(ms);
            return $"{(long)time.TotalHours:00}:{time.Minutes:00}:{time.Seconds:00}";
        }
    }
}
public sealed class Meeting
{
    public string Title { get; set; } = "";
    public string Time { get; set; } = "";
    public string Url { get; set; } = "";
    public string Provider { get; set; } = "";
}
public sealed class PortalState
{
    public int Protocol { get; set; }
    public long? Uid { get; set; }
    public long ObservedAt { get; set; }
    public WorkTimer? Timer { get; set; }
    public PortalTask? Selected { get; set; }
    public List<PortalTask> Tasks { get; set; } = [];
    public List<Meeting> Meetings { get; set; } = [];
    public string DailyUrl { get; set; } = "";
    public string TimeZone { get; set; } = "auto";
    public string ResolvedTimeZone { get; set; } = "";
    public string Status { get; set; } = "";
    public string MeetingsStatus { get; set; } = "idle";
    public string MeetingsError { get; set; } = "";
    public string MeetingsDate { get; set; } = "";
    public string MeetingsTimeZone { get; set; } = "";
    public double? MeetingsOffsetSeconds { get; set; }
    public bool MeetingsCached { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public bool MeetingsCurrent
    {
        get
        {
            try
            {
                if (MeetingsTimeZone.Length > 0) return MeetingsDate == TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById(MeetingsTimeZone)).ToString("yyyy-MM-dd");
                return MeetingsOffsetSeconds is double offset && MeetingsDate == DateTimeOffset.UtcNow.AddSeconds(offset).ToString("yyyy-MM-dd");
            }
            catch (TimeZoneNotFoundException) { return false; }
            catch (InvalidTimeZoneException) { return false; }
        }
    }
    public bool ShowAllMeetings { get; set; }
    public bool DayDone { get; set; }
    public bool Pending { get; set; }
    public bool CanPrimary { get; set; }
    public bool CanPause { get; set; }
    public bool CanQuickAdd { get; set; }
    public bool CanConfigure { get; set; }
    public bool CanChangeTask { get; set; }
    public bool CanChangeTimeZone { get; set; }
    public bool Configuring { get; set; }
    public bool CanCancel { get; set; }
}
public sealed class BridgeMessage
{
    public string Type { get; set; } = "";
    public string? Id { get; set; }
    public PortalState? State { get; set; }
    public string? Error { get; set; }
}
