const InternalSecretKey = 'InternalSecretKey';

const FalconZone = {
  Falcon: 'Falcon',
  FalconLabel: 'FalconLabel', // compound of Falcon - should get sanitized too
};

function describe(zone) {
  switch (zone) {
    case FalconZone.Falcon:
      return 'Falcon zone active';
    case FalconZone.FalconLabel:
      return 'FalconLabel zone active';
    default:
      return 'Falconry note: plain substring match, this gets touched too';
  }
}

function getSecretKeyName() {
  return InternalSecretKey;
}

// nativApp contains "nativ" as a substring and still gets sanitized;
// nativeElement and provideNativeDateAdapter are protected tokens (Angular
// API members) and must stay untouched even though both also contain "nativ".
const nativApp = 'nativ config label';
const nativeElement = 'DOM API member - must stay untouched';
function provideNativeDateAdapter() {
  return 'Angular Material API - must stay untouched';
}

module.exports = { FalconZone, describe, getSecretKeyName, nativApp, nativeElement, provideNativeDateAdapter };
