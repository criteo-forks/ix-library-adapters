'use strict';

function getPartnerId() {
    return 'CriteoHtb';
}

function getStatsId() {
    return 'CRTB';
}

function getCallbackType() {
    return 'NONE';
}

function getArchitecture() {
    return 'SRA';
}

function getBidRequestRegex() {
    return {
        method: 'POST',
        urlRegex: /(bidder\.criteo\.com*)|(directbidder-test-app\.par\.preprod\.crto\.in*)/
    };
}

function getConfig() {
    return {
        xSlots: {
            1: {
                zoneId: '123'
            },
            2: {
                zoneId: '456'
            }
        }
    };
}

function validateBidRequest(request) {
    expect(['bidder.criteo.com', 'directbidder-test-app.par.preprod.crto.in']).toContain(request.host);
    expect(request.protocol).toBe('https:');

    expect(request.query.profileId).toBe('154');
    expect(request.query.av).toBe('1');
    expect(request.query.wv).toBe('index');
    expect(request.query.cb).toBeDefined();

    var body = JSON.parse(request.body);

    expect(body.publisher.url).toBeDefined();
    expect(body.slots.length).toBe(2);

    expect(body.slots[0].zoneid).toBe('123');
    expect(body.slots[1].zoneid).toBe('456');
}

function getValidResponse(request, creative) {
    var slotsFromRequest = JSON.parse(request.body).slots;
    var response = {
        slots: slotsFromRequest.map(function (slot) {
            return {
                impid: slot.impid,
                zoneid: slot.zoneid,
                width: 300,
                height: 250,
                cpm: 2,
                creative: creative
            };
        })
    };

    return JSON.stringify(response);
}

function validateTargeting(targetingMap) {
    expect(targetingMap).toEqual(jasmine.objectContaining({
        ix_cdb_om: jasmine.arrayContaining([jasmine.stringMatching(/300x250_\d+/)]),
        ix_cdb_id: jasmine.arrayContaining([jasmine.any(String)])
    }));
}

function getPassResponse(request) {
    var slotsFromRequest = JSON.parse(request.body).slots;
    var response = {
        slots: slotsFromRequest.map(function (slot) {
            return {
                impid: slot.impid,
                zoneid: slot.zoneid,
                width: 300,
                height: 250,
                cpm: 0
            };
        })
    };

    return JSON.stringify(response);
}

module.exports = {
    getPartnerId: getPartnerId,
    getStatsId: getStatsId,
    getCallbackType: getCallbackType,
    getArchitecture: getArchitecture,
    getConfig: getConfig,
    getBidRequestRegex: getBidRequestRegex,
    validateBidRequest: validateBidRequest,
    getValidResponse: getValidResponse,
    validateTargeting: validateTargeting,
    getPassResponse: getPassResponse
};
