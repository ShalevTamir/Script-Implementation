// A standalone excluded file (matched by exact basename, not just directories).
// Falcon appears here too, purely to confirm this file never reaches the export output at all.
namespace MockDotnetLibrary
{
    internal static class InternalOnlyNotes
    {
        public const string Note = "Falcon classified notes - never export this file.";
    }
}
