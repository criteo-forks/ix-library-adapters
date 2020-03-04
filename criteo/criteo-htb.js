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
var Network = require('network.js');
var Utilities = require('utilities.js');

var ComplianceService;
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
    const CDB_ENDPOINT = 'https://bidder.criteo.com/cdb';
    const PROFILE_ID_INLINE = 154;
    const ADAPTER_VERSION = 1;

    var __baseClass;
    var __profile;

    function parseQS(query) {
        return !query ? {} : query
        .replace(/^\?/, '')
        .split('&')
        .reduce((acc, criteria) => {
            let [k, v] = criteria.split('=');
            if (/\[\]$/.test(k)) {
              k = k.replace('[]', '');
              acc[k] = acc[k] || [];
              acc[k].push(v);
            } else {
              acc[k] = v || '';
            }
            return acc;
        }, {});
    }

    function buildContext() {
        const pageUrl = document.createElement('a');
        pageUrl.href = Browser.getPageUrl();
        const queryString = parseQS(pageUrl.search || '');

        return {
            url: pageUrl.href,
            debug: queryString['pbt_debug'] === '1',
            noLog: queryString['pbt_nolog'] === '1'
        };
    }

    function buildCdbUrl(context) {
        let url = CDB_ENDPOINT;
        url += '?profileId=' + String(PROFILE_ID_INLINE);
        url += '&av=' + String(ADAPTER_VERSION);
        url += '&wv=index'
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
        const slots = [];

        parcels.forEach(parcel => {
            if(parcel.xSlotRef && parcel.xSlotRef.zoneId) {
                const slot = {
                    impid: parcel.htSlot.getName(),
                    zoneid: parcel.xSlotRef.zoneId
                };
               slots.push(slot);
            }
        })

        const request = {
            publisher: {
                url: context.url,
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
        let url;
        let data;
        
        const context = buildContext();
        url = buildCdbUrl(context);
        data = buildCdbRequest(context, returnParcels);
        
        if (data) {
            return {
                url: url,
                data: data,
                networkParamOverrides: {
                    method: 'POST'
                }
            };
        }
    }

    function __parseResponse(sessionId, adResponse, returnParcels) {
        for (var parcelIndex = 0; parcelIndex < returnParcels.length; parcelIndex++) {
            var parcel = returnParcels[parcelIndex];
            var headerStatsInfo = {};
            var htSlotId = parcel.htSlot.getId();
            headerStatsInfo[htSlotId] = {};
            headerStatsInfo[htSlotId][parcel.requestId] = [parcel.xSlotName];

            if (adResponse && adResponse.slots && Utilities.isArray(adResponse.slots)) {
                var slot = undefined;
                for(var slotIndex = 0; slotIndex < adResponse.slots.length; slotIndex++) {
                    if(parcel.htSlot.getName() === adResponse.slots[slotIndex].impid && parcel.xSlotRef.zoneId && parcel.xSlotRef.zoneId == adResponse.slots[slotIndex].zoneid) {
                        slot = adResponse.slots[slotIndex];
                        break;
                    }
                }

                if(!slot) {
                    if (__profile.enabledAnalytics.requestTime) {
                        __baseClass._emitStatsEvent(sessionId, 'hs_slot_pass', headerStatsInfo);
                    }        
                    parcel.pass = true;
                    continue;
                }

                var bidCpm = Number(slot.cpm);
                
                if (!Utilities.isNumber(bidCpm) || bidCpm <= 0) {
                    //? if (DEBUG) {
                    Scribe.info(__profile.partnerId + ' returned pass for { id: ' + adResponse.id + ' }.');
                    //? }
                    if (__profile.enabledAnalytics.requestTime) {
                        __baseClass._emitStatsEvent(sessionId, 'hs_slot_pass', headerStatsInfo);
                    }
                    parcel.pass = true;
                    continue;
                }

                if (__profile.enabledAnalytics.requestTime) {
                    __baseClass._emitStatsEvent(sessionId, 'hs_slot_bid', headerStatsInfo);
                }       

                parcel.size = [Number(slot.width), Number(slot.height)];
                parcel.targetingType = 'slot';
                parcel.targeting = {};

                //? if(FEATURES.GPT_LINE_ITEMS) {
                const sizeKey = Size.arrayToString(parcel.size);
                const targetingCpm = __baseClass._bidTransformers.targeting.apply(bidCpm);

                parcel.targeting[__baseClass._configs.targetingKeys.om] = [sizeKey + '_' + targetingCpm];
                parcel.targeting[__baseClass._configs.targetingKeys.id] = [parcel.requestId];
                //? }

                //? if(FEATURES.RETURN_CREATIVE) {
                parcel.adm = slot.creative;
                //? }

                //? if(FEATURES.RETURN_PRICE) {
                parcel.price = Number(__baseClass._bidTransformers.price.apply(bidCpm));
                //? }

                var pubKitAdId = RenderService.registerAd({
                    sessionId: sessionId,
                    partnerId: __profile.partnerId,
                    adm: slot.creative,
                    requestId: parcel.requestId,
                    size: parcel.size,
                    price: targetingCpm,
                    timeOfExpiry: __profile.features.demandExpiry.enabled ? (__profile.features.demandExpiry.value + System.now()) : 0
                });

                //? if(FEATURES.INTERNAL_RENDER) {
                curReturnParcel.targeting.pubKitAdId = pubKitAdId;
                //? }
            }
        }
    }

    /* =====================================
     * Constructors
     * ---------------------------------- */

    (function __constructor() {
        ComplianceService = SpaceCamp.services.ComplianceService;
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
                om: 'ix_cdb_om',
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
