namespace MockDotnetLibrary
{
    public enum FalconZone
    {
        Falcon,
        FalconLabel // compound of Falcon - should get sanitized too
    }

    public class WidgetService
    {
        private const string InternalSecretKey = "InternalSecretKey";

        public string Describe(FalconZone zone)
        {
            return zone switch
            {
                FalconZone.Falcon => "Falcon zone active",
                FalconZone.FalconLabel => "FalconLabel zone active",
                _ => "Falconry note: plain substring match, this gets touched too"
            };
        }

        public string GetSecretKeyName() => InternalSecretKey;
    }
}
