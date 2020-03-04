'use strict';

////////////////////////////////////////////////////////////////////////////////
// Dependencies ////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

var Browser = require('browser.js');
var Classify = require('classify.js');
var Constants = require('constants.js');
var Partner = require('partner.js');
var Size = require('size.js');
var SpaceCamp = require('space-camp.js');
var System = require('system.js');
var Utilities = require('utilities.js');

var RenderService;

//? if (DEBUG) {
var ConfigValidators = require('config-validators.js');
var PartnerSpecificValidator = require('criteo-htb-validator.js');
var Scribe = require('scribe.js');
var Whoopsie = require('whoopsie.js');
//? }

////////////////////////////////////////////////////////////////////////////////
// Main ////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

/**
 * Partner module template
 *
 * @class
 */
function CriteoHtb(configs) {
    var CDB_ENDPOINT = 'https://bidder.criteo.com/cdb';
    var PROFILE_ID_INLINE = 154;
    var ADAPTER_VERSION = 1;

    var __baseClass;
    var __profile;

    function parseQS(query) {
        return !query ? {} : query
            .replace(/^\?/, '')
            .split('&')
            .reduce(function (acc, criteria) {
                var splited = criteria.split('=');
                if (/\[\]$/.test(splited[0])) {
                    splited[0] = splited[0].replace('[]', '');
                    acc[splited[0]] = acc[splited[0]] || [];
                    acc[splited[0]].push(splited[1]);
                } else {
                    acc[splited[0]] = splited[1] || '';
                }

                return acc;
            }, {});
    }

    function buildContext() {
        var pageUrl = document.createElement('a');
        pageUrl.href = Browser.getPageUrl();
        var queryString = parseQS(pageUrl.search || '');

        return {
            url: pageUrl.href,
            debug: queryString.pbt_debug === '1',
            noLog: queryString.pbt_nolog === '1'
        };
    }

    function buildCdbUrl(context) {
        var url = CDB_ENDPOINT;
        url += '?profileId=' + String(PROFILE_ID_INLINE);
        url += '&av=' + String(ADAPTER_VERSION);
        url += '&wv=index';
        url += '&cb=' + String(Math.floor(Math.random() * 99999999999));

        if (context.debug) {
            url += '&debug=1';
        }

        if (context.noLog) {
            url += '&nolog=1';
        }

        return url;
    }

    function buildCdbRequest(context, parcels) {
        var slots = [];

        parcels.forEach(function (parcel) {
            if (parcel.xSlotRef && parcel.xSlotRef.zoneId) {
                var slot = {
                    impid: parcel.htSlot.getName(),
                    zoneid: parcel.xSlotRef.zoneId
                };
                slots.push(slot);
            }
        });

        var request = {
            publisher: {
                url: context.url
            },
            slots: slots
        };

        return request;
    }

    /**
     * Generates the request URL and query data to the endpoint for the xSlots
     * in the given returnParcels.
     *
     * @param  {object[]} returnParcels
     *
     * @return {object}
     */
    function __generateRequestObj(returnParcels) {
        var url;
        var data;

        var context = buildContext();
        url = buildCdbUrl(context);
        data = buildCdbRequest(context, returnParcels);

        return {
            url: url,
            data: data,
            networkParamOverrides: {
                method: 'POST'
            }
        };
    }

    function buildHeaderStatsInfo(parcel) {
        var headerStatsInfo = {};
        var htSlotId = parcel.htSlot.getId();
        headerStatsInfo[htSlotId] = {};
        headerStatsInfo[htSlotId][parcel.requestId] = [parcel.xSlotName];

        return headerStatsInfo;
    }

    function passParcel(sessionId, parcel) {
        //? if (DEBUG) {
        Scribe.info(__profile.partnerId + ' returned pass for { ' + parcel.xSlotName + ' }.');
        //? }
        if (__profile.enabledAnalytics.requestTime) {
            __baseClass._emitStatsEvent(sessionId, 'hs_slot_pass', buildHeaderStatsInfo(parcel));
        }
        parcel.pass = true;
    }

    function bidParcel(sessionId, slot, parcel) {
        if (__profile.enabledAnalytics.requestTime) {
            __baseClass._emitStatsEvent(sessionId, 'hs_slot_bid', buildHeaderStatsInfo(parcel));
        }

        parcel.size = [Number(slot.width), Number(slot.height)];
        parcel.targetingType = 'slot';
        parcel.targeting = {};

        var bidCpm = Number(slot.cpm);

        //? if(FEATURES.GPT_LINE_ITEMS) {
        var sizeKey = Size.arrayToString(parcel.size);
        var targetingCpm = __baseClass._bidTransformers.targeting.apply(bidCpm);

        parcel.targeting[__baseClass._configs.targetingKeys.om] = [sizeKey + '_' + targetingCpm];
        parcel.targeting[__baseClass._configs.targetingKeys.id] = [parcel.requestId];
        //? }

        //? if(FEATURES.RETURN_CREATIVE) {
        parcel.adm = slot.creative;
        //? }

        //? if(FEATURES.RETURN_PRICE) {
        parcel.price = Number(__baseClass._bidTransformers.price.apply(bidCpm));
        //? }

        var profileFeaturesExpiry = __profile.features.demandExpiry;
        var pubKitAdId = RenderService.registerAd({
            sessionId: sessionId,
            partnerId: __profile.partnerId,
            adm: slot.creative,
            requestId: parcel.requestId,
            size: parcel.size,
            price: targetingCpm,
            timeOfExpiry: profileFeaturesExpiry.enabled ? profileFeaturesExpiry.value + System.now() : 0
        });

        //? if(FEATURES.INTERNAL_RENDER) {
        parcel.targeting.pubKitAdId = pubKitAdId;
        //? }
    }

    function distributeParcels(adResponse, returnParcels) {
        var passParcels = [];
        var bidWithParcels = [];

        for (var parcelIndex = 0; parcelIndex < returnParcels.length; parcelIndex++) {
            var parcel = returnParcels[parcelIndex];

            if (adResponse && adResponse.slots && Utilities.isArray(adResponse.slots)) {
                var slot;
                for (var slotIndex = 0; slotIndex < adResponse.slots.length; slotIndex++) {
                    if (parcel.htSlot.getName() === adResponse.slots[slotIndex].impid
                        && parcel.xSlotRef.zoneId
                        && Number(parcel.xSlotRef.zoneId) === Number(adResponse.slots[slotIndex].zoneid)) {
                        slot = adResponse.slots[slotIndex];

                        break;
                    }
                }

                if (!slot) {
                    passParcels.push(parcel);

                    continue;
                }

                var bidCpm = Number(slot.cpm);

                if (!Utilities.isNumber(bidCpm) || bidCpm <= 0) {
                    passParcels.push(parcel);

                    continue;
                }

                bidWithParcels.push({
                    slot: slot,
                    parcel: parcel
                });
            }
        }

        return {
            passParcels: passParcels,
            bidWithParcels: bidWithParcels
        };
    }

    function __parseResponse(sessionId, adResponse, returnParcels) {
        var parcelDistributed = distributeParcels(adResponse, returnParcels);

        for (var passParcelIndex = 0; passParcelIndex < parcelDistributed.passParcels.length; passParcelIndex++) {
            passParcel(sessionId, parcelDistributed.passParcels[passParcelIndex]);
        }

        for (var bidWithParcelIndex = 0;
            bidWithParcelIndex < parcelDistributed.bidWithParcels.length;
            bidWithParcelIndex++) {
            bidParcel(sessionId,
                parcelDistributed.bidWithParcels[bidWithParcelIndex].slot,
                parcelDistributed.bidWithParcels[bidWithParcelIndex].parcel);
        }
    }

    /* =====================================
     * Constructors
     * ---------------------------------- */

    (function __constructor() {
        RenderService = SpaceCamp.services.RenderService;

        /* =============================================================================
         * STEP 1  | Partner Configuration
         * -----------------------------------------------------------------------------
         *
         * Please fill out the below partner profile according to the steps in the README doc.
         */

        /* ---------- Please fill out this partner profile according to your module ------------ */
        __profile = {
            partnerId: 'CriteoHtb',
            namespace: 'CriteoHtb',
            statsId: 'CRTB',
            version: '2.2.0',
            targetingType: 'slot',
            enabledAnalytics: {
                requestTime: true
            },
            features: {
                demandExpiry: {
                    enabled: false,
                    value: 0
                },
                rateLimiting: {
                    enabled: false,
                    value: 0
                }
            },

            targetingKeys: {
                id: 'ix_cdb_id',
                om: 'ix_cdb_om'
            },

            bidUnitInCents: 100,
            lineItemType: Constants.LineItemTypes.ID_AND_SIZE,
            callbackType: Partner.CallbackTypes.NONE,
            architecture: Partner.Architectures.SRA,
            requestType: Partner.RequestTypes.AJAX
        };

        /* --------------------------------------------------------------------------------------- */

        //? if (DEBUG) {
        var results = ConfigValidators.partnerBaseConfig(configs) || PartnerSpecificValidator(configs);

        if (results) {
            throw Whoopsie('INVALID_CONFIG', results);
        }
        //? }

        __baseClass = Partner(__profile, configs, null, {
            parseResponse: __parseResponse,
            generateRequestObj: __generateRequestObj
        });
    })();

    /* =====================================
     * Public Interface
     * ---------------------------------- */

    var derivedClass = {
        /* Class Information
         * ---------------------------------- */

        //? if (DEBUG) {
        __type__: 'CriteoHtb',
        //? }

        //? if (TEST) {
        __baseClass: __baseClass,
        //? }

        /* Data
         * ---------------------------------- */

        //? if (TEST) {
        profile: __profile,
        //? }

        /* Functions
         * ---------------------------------- */

        //? if (TEST) {
        parseResponse: __parseResponse,
        generateRequestObj: __generateRequestObj
        //? }
    };

    return Classify.derive(__baseClass, derivedClass);
}

////////////////////////////////////////////////////////////////////////////////
// Exports /////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

module.exports = CriteoHtb;
