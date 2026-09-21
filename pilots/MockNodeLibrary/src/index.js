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

module.exports = { FalconZone, describe, getSecretKeyName };
