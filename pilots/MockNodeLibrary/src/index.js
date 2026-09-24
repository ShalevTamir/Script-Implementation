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

// namedValues (mapping.json) only matches a value when its tied variable
// name is on the same line: dbHost's line has both "dbHost" and "10.20.30.40"
// so it converts. ports' line has both "ports" and "5432", so only the
// exact 5432 token converts - 15432/25432 (same line, same value as a
// substring) are left alone.
const dbHost = '10.20.30.40';
const ports = [5432, 15432, 25432];

module.exports = {
  FalconZone,
  describe,
  getSecretKeyName,
  nativApp,
  nativeElement,
  provideNativeDateAdapter,
  dbHost,
  ports,
};
