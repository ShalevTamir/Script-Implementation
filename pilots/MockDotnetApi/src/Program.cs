using System;
using MockDotnetLibrary;

namespace MockDotnetApi
{
    public static class Program
    {
        public static void Main(string[] args)
        {
            var service = new WidgetService();
            Console.WriteLine(service.Describe(FalconZone.Falcon));
            Console.WriteLine(service.Describe(FalconZone.FalconLabel));
            Console.WriteLine($"Secret key name: {service.GetSecretKeyName()}");
        }
    }
}
