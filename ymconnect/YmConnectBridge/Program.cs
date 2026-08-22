using System;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace YmConnectBridge;

/// <summary>
/// Soft-dependency helper for YMConnect::KinematicsInterface::ConvertPosition.
///
/// Build against the YMConnect .NET package after installing from:
///   https://github.com/Yaskawa-Global/YMConnect/releases
/// Docs:
///   https://developer.motoman.com/en/YMConnect
///   https://developer.motoman.com/en/YMConnect/KinematicsInterface
///
/// Without the SDK referenced, this stub answers --status / --convert with
/// structured JSON so the Tauri app can show install instructions.
/// When the real SDK is linked, replace StubConvert with live ConvertPosition.
///
/// Controllers: YRC1000+ required for Motion/Kinematics interfaces.
/// </summary>
public static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help")
        {
            Console.Error.WriteLine("YmConnectBridge --status | --convert <json>");
            return 2;
        }

        if (args[0] == "--status")
        {
            WriteJson(new JsonObject
            {
                ["ok"] = true,
                ["sdkLinked"] = SdkLinked,
                ["message"] = SdkLinked
                    ? "YMConnect SDK linked — ready for controller calls."
                    : "Stub build: link YMConnect NuGet/DLL then rebuild. Offline pendant path remains available."
            });
            return 0;
        }

        if (args[0] == "--convert")
        {
            if (args.Length < 2)
            {
                WriteUnavailable("Missing JSON payload after --convert");
                return 1;
            }

            try
            {
                var request = JsonNode.Parse(args[1]) as JsonObject
                    ?? throw new InvalidOperationException("Payload must be a JSON object");
                var result = ConvertPosition(request);
                WriteJson(result);
                return result["ok"]?.GetValue<bool>() == true ? 0 : 1;
            }
            catch (Exception ex)
            {
                WriteUnavailable(ex.Message);
                return 1;
            }
        }

        WriteUnavailable($"Unknown argument: {args[0]}");
        return 2;
    }

    /// <summary>Flip to true after adding a ProjectReference / PackageReference to YMConnect.</summary>
    private const bool SdkLinked = false;

    private static JsonObject ConvertPosition(JsonObject request)
    {
        if (!SdkLinked)
        {
            return Unavailable(
                "YMConnect SDK not linked into YmConnectBridge. Install the release, add the package reference, set SdkLinked=true, and rebuild."
            );
        }

        // Placeholder for live integration:
        //   var status = default(StatusInfo);
        //   var c = YMConnect.OpenConnection(host, status);
        //   c.Kinematics.ConvertPosition(R1, pulsePos, PulseToCartesianPos, cartPos);
        //   YMConnect.CloseConnection(c);
        _ = request;
        return Unavailable("SdkLinked is true but ConvertPosition body is not implemented yet.");
    }

    private static JsonObject Unavailable(string reason) => new()
    {
        ["ok"] = false,
        ["unavailable"] = true,
        ["reason"] = reason,
        ["installHint"] =
            "Download YMConnect from https://github.com/Yaskawa-Global/YMConnect/releases and follow https://developer.motoman.com/en/YMConnect quick start (YRC1000+).",
        ["docs"] = new JsonObject
        {
            ["home"] = "https://developer.motoman.com/en/YMConnect",
            ["kinematics"] = "https://developer.motoman.com/en/YMConnect/KinematicsInterface",
            ["releases"] = "https://github.com/Yaskawa-Global/YMConnect/releases",
            ["note"] = "Motion and Kinematics interfaces require YRC1000 or newer."
        }
    };

    private static void WriteUnavailable(string reason) => WriteJson(Unavailable(reason));

    private static void WriteJson(JsonObject node)
    {
        Console.WriteLine(node.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
    }
}
