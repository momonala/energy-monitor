# Ostrom mobile API

Unofficial notes on the REST API behind the Ostrom iOS app (`https://api.ostrom.de/v1`), reverse-engineered from mitmproxy captures. Written to support pulling account, contract and meter data into energy-monitor.

## Provenance and trust level

- Captured 2026-10-31 from the iOS app, version `6.4.0` (`x-app-version`), in two sessions. The first had a cold start, a 401 burst, one token refresh, normal screens and one meter-reading submit. The second was a warm start with no refresh.
- **Replayed 2026-10-31 from a Mac** with the captured tokens. The refresh and all 19 GET endpoints below succeeded (`201` / `200`). The meter-reading POST was not replayed.
- Tooling and raw flows: `~/code/projects/sniff` (`data/raw/*.flow`, extracted to `data/processed/*.json`; gitignored, they hold live tokens).
- Field types come from one account (two electricity contracts, one smart meter, no linked devices). Optional fields may be missing for other accounts.

## Conventions

| | |
|---|---|
| Base URL | `https://api.ostrom.de/v1` |
| Format | JSON in, JSON out. Writes use `content-type: application/json`. |
| IDs | `{user_id}` and `{contract_id}` are integers. Get both from the API itself, see [Auth](#auth) and [Account](#account). |
| Pinning | None. `api.ostrom.de` handshakes succeeded through the proxy. |
| Caching | The app sends `if-none-match` and gets `304` with no body. Omit it to always get a full `200` (verified). |
| Rate limit | Response headers `x-ratelimit-limit: 50`, `x-ratelimit-remaining`, `x-ratelimit-reset`. The window length is not known (`reset` was `0`). A 20-call run left 49 remaining. |
| Errors | `401` body is `{"statusCode":401,"message":"Unauthorized"}`. No other error shape was seen. |
| Client headers | The replay sent `user-agent: OstromMobile/1254 CFNetwork/3860.700.2 Darwin/25.6.0`, `x-app-version: 6.4.0`, `accept-language` and `accept: application/json`. Which of these are required was not isolated. Sentry headers (`sentry-trace`, `baggage`) are not needed. |

## Auth

Two cookies on `ostrom.de`, both HS256 JWTs:

| Cookie | Claims | Lifetime |
|---|---|---|
| `access_token` | `exp, iat, sub, tokenType: "auth", user` | 8 hours (`exp - iat`) |
| `refresh_token` | `exp, iat, sub, tokeType, user` (the claim name really is misspelled) | 1 year |

Data calls need only the `access_token` cookie (verified: a replay with just that cookie returned `200`). When it expires the API returns `401`, and the app calls the refresh endpoint and retries.

```
GET  /v1/users/{user_id}/home-page-info   -> 401   (x ~20 in parallel on cold start)
POST /v1/auth/refresh                      -> 201   + Set-Cookie: access_token=<new>
GET  /v1/users/{user_id}/home-page-info   -> 200   (all calls retried)
```

### `POST /auth/refresh`

| | |
|---|---|
| Request headers | `content-type: application/json`, `Cookie: access_token=<expired>; refresh_token=<token>`, `x-session-token: <token>` (same value as the `refresh_token` cookie) |
| Request body | `{}` |
| Response | `201` `{"id": int, "success": bool, "intercomUserId": str, "intercomAndroidHash": str, "intercomIosHash": str}` |
| Side effect | `Set-Cookie: access_token=<jwt>; HttpOnly; Domain=ostrom.de; Path=/; Max-Age=86400000`. No new `refresh_token` is issued, so refreshing from another client leaves the phone's session alone. |

`id` in the response equals the `{user_id}` in every `/users/{user_id}/...` path. It is the only call that returns the ID without needing to know it first.

The replay sent both cookies and the header. Whether the server checks the `refresh_token` cookie, the header, or both was not isolated.

### Gotchas

- **HTTP/2 cookie splitting.** iOS sends each cookie as its own `cookie` header field. Joining them with `", "` (what mitmproxy's `headers["cookie"]` does) produces one mangled cookie that the server rejects with `401`. Join with `"; "`. `sniff`'s `extract.py` does this as of 2026-10-31; extracts made before that have broken cookie values.
- The phone's cookie jar can hold an old and a new `access_token` at once, and sends both. The server accepted that.
- On data calls the app sends `x-session-token: [object Object]` (a stringified JS object). The server ignores it.
- The cookie's `Max-Age=86400000` is not the lifetime; the JWT `exp` is.

### Not captured: login

The initial login is still unknown. The refresh token lasts a year, so a client can run on a token copied from the phone until it expires or the phone logs out. Then re-capture, or capture the login itself: log out in the app, start a fresh `sniff` run, log in.

### Refresh sketch

```bash
curl -si https://api.ostrom.de/v1/auth/refresh \
  -X POST -H 'content-type: application/json' -d '{}' \
  -H "x-session-token: $OSTROM_REFRESH_TOKEN" \
  -H "Cookie: access_token=$OSTROM_ACCESS_TOKEN; refresh_token=$OSTROM_REFRESH_TOKEN"
```

This mirrors the replayed request; the exact command was not run. Keep both tokens in the macOS Keychain, not in a file or the repo.

## Account

### `GET /users/{user_id}`

```
id: int, email, firstName, lastName, phone, phoneAreaCode, language, status: str
roles: [str], adminLoginAllowed: bool, pending: bool
powerCloudId: int, lastAuthenticated: str
hasSmartMeter, hasElectricVehicle, hasHeatPump, interestedInThgQuota: bool
intercomContactId, intercomUserId: str
userSettings: {displayNameOnTheReferralLeaderboard, enableChargerLinking, enableEvLinking: bool}
hasFaceIdPublicKey: bool, developerTermsAndConditionsAcceptedAt: null | str
createdAt, updatedAt: str
```

Contains PII (name, email, phone). Do not log it.

### `GET /users/{user_id}/home-page-info`

The app's main bootstrap call and the best source for contract IDs.

```
contracts.electricity: [Contract]     (2 in the capture, see below)
chargerLinkingAllowed, evLinkingAllowed, hvacLinkingAllowed: bool
hasCharger, hasElectricVehicle, hasHvac, hasFaceIdPublicKey: bool
hasOnlyCancelledContracts, hasExpiredContractWithoutFinalInvoice: bool
live, pendingAction, pendingOrderInfoSubmission: bool
movingBonus: int
orderId, powerCloudAction: null in the capture, type when set unknown
```

These are all 16 top-level keys in the capture.

`Contract` object:

```
id: int                       <- {contract_id} for /contracts/{contract_id}/...
orderId, customerId: int
status, statusCode, statusCodeTitle: str
startDate, desiredStartDate, endDate, desiredEndDate, lastRevocationDate, nextCancellationDate: str
productCode, productName, campaign: str
usage, usageNet, directDebit: int
marketLocationId, meterLocationId, meterNumber: str
iban, alternativeAccountHolder: str
user, billingUser, address, billingAddress, smartMeter: object
hasSmartMeterData, vppEligible, cancellationRequested, hasPriceCap, dynamicPricingEnabled: bool
priceCapStartDate: null | str, settings: null
```

An account can hold several contracts, and the one in the capture had two: `status: "expired"` / `statusCode: "7000"` and `status: "active"` / `statusCode: "5000"`. Pick the active one by `status` rather than by position. The app's meter-reading and graph calls used the active contract's `id`. Contains PII (IBAN, addresses, meter and market location IDs).

### `GET /users/{user_id}/emissions-info`

`totalKgC02Offset`, `totalUserKgC02Offset`, `totalUserkWhYearUsage`, `totalUserAndReferralsKgCO2Offset`, `totalUserAndReferralskWhUsage` (all int), plus `userComparisons` and `userAndReferralsComparisons` arrays of `{description, baseValue, type, imageName, sourceName, sourceUrl, total}`. Note the inconsistent casing (`KgC02` vs `KgCO2`); copy field names exactly.

### `GET /users/{user_id}/account-transactions`

Bonus and credit ledger.

```
transactions: [{
  id, userId: int
  type, subType, originId, status, availableAt, createdAt: str
  amount, invoiceCreditsAmount, marketPlaceCreditsAmount: int
  updatedAt, storeCodeUsedAt, storeOrderId, cancelledAt, cancellationReason: null in the replay
}]
currentInvoiceCreditsAmount, currentMarketPlaceCreditsAmount: int
```

### `GET /users/{user_id}/referrals-info`

```
code, referralPageLink, referralPayoutSchedule: str
discountAmount, totalPendingReferral, totalPaidReferral, amountPaidReferral, amountPendingReferral: int
invoiceCreditAmount, storeCreditAmount, referrerBonusAmount: int
totalWelcomBonusAmount, monthlyWelcomBonusAmount: int     ("Welcom" sic)
isEligibleToConnectBonus, activeBonusStatus: bool
connectBonusAvailableAt, invoiceConnectBonusAmount, invoiceStoreBonusAmount,
isDeviceConnected, oldBonusAvailableAt: null in the replay
```

### `GET /configurations/version-support`

```
android: {version, description_en, description_de: str}
ios:     {version, description_en, description_de: str}
```

Presumably the minimum supported app version per platform. Whether the API rejects requests with an older `x-app-version` was not tested.

## Contract

All paths take `{contract_id}` from `home-page-info`.

### `GET /contracts/{contract_id}/meter-readings`

Array, newest first, 29 entries. No query parameters were used and no pagination was seen.

```
meterReadingId: str
obis: str            "1-0:1.8.0"
value: int           cumulative register value
difference: int      change since the previous reading
status: str          CONFIRMED
origin: str          CUSTOMER | GRID
qualifier: str       read | estimated
readAt: str          "YYYY-MM-DD HH:MM:SS" (timezone not known)
createdAt: str
```

OBIS `1-0:1.8.0` is the standard code for total active energy imported, normally in kWh. The units were not stated by the API. `origin: GRID` rows come from the grid operator and `CUSTOMER` rows are manual submissions from the app, so the series mixes both.

### `POST /contracts/{contract_id}/meter-readings`

Submits a manual reading to the supplier. Response `201` `{"success": true}`. Not replayed.

```json
{
  "readAtDate": "YYYY-MM-DD",
  "meterReadings": [{"obis": "1-0:1.8.0", "readingValue": "<digits as string>"}],
  "forceInvoice": false,
  "reviewedByUser": false,
  "isInterimInvoice": false
}
```

Note `readingValue` is a string here but `value` is an int on read. The app sent all three flags as `false`; send the same. What `forceInvoice` and `isInterimInvoice` do was not tested, so leave them `false` rather than guess.

### `GET /contracts/{contract_id}/registers`

```
[{ activeFrom: str, activeUntil: null | str, obis: str, digits: str, precision: str,
   isBillingRelevant: bool, counterNumber: str,
   lastReading: {readAt: str, obis: str, value: int} }]
```

One register (`1-0:1.8.0`). `lastReading` is the cheapest way to get the latest value.

### `GET /contracts/{contract_id}/graph-info`

Consumption and cost history behind the app's graph.

```
contractStatus, contractStartDate, calculatedUntilDate: str
amountOfPayments, amountOfTariffs, amountOfMeterReadings, month, year: int
estimatedBalanceLastMonth, estimatedBalanceForToday: int
consumptionInfoPerMonth: [{            (18 entries)
  month, year: int
  expectedkWh, currentkWh, expectedPrice, currentPrice, accumulatedPrice, paymentAmount: int
  previousAmountOfDaysToCalculateConsumption, previousPricePerkWh,
  previousAdditionalMonthlyPrice, previousCurrentkWh, previousCurrentPrice, previousPaymentAmount: int
}]
```

All numbers came back as JSON integers. Price units (euros or cents) were not verified.

### `GET /contracts/{contract_id}/monthly-payment`

```
currentPayment, suggestedPayment, min, max, estimatedBalanceLastMonth: int
calculatedUntilDate, expectedDepositDate: str
pending: bool
flexBonusTotal, flexBonusMonthly, currentPaymentWithDiscount: null in the replay
```

## Devices and live power

Relevant to energy-monitor because it gives Ostrom's own view of household power.

| Endpoint | Shape |
|---|---|
| `GET /smart-devices/energy-flow` | `{householdPowerKw: int, calculationUpdatedAt: str}` |
| `GET /smart-devices/energy-flow/graph` | `{deviceGroups: [{name, status: str, powerKw: int}] (4 groups: grid, inverter, battery, devices), energyFlows: [], updatedAt: str}`. Optional per group: `battery` also has `batteryChargeLevel` (null in the capture) and `devices` also has `subgroups` (`vehicle`, `hvac`), each `{name, status, powerKw, chargeLevel}`. |
| `GET /meters`, `/batteries`, `/chargers`, `/hems`, `/hvacs`, `/inverters`, `/vehicles` | `200` with `[]` for this account (nothing linked), so the item shape is unknown. Top-level paths, not nested under a user or contract. |

`householdPowerKw` came back as an integer, so check whether it is rounded before comparing it with the MT681 readings.

## Open questions

- How the login issues the refresh token, and what happens to it when the phone logs out.
- Whether refresh checks the `refresh_token` cookie, the `x-session-token` header, or both.
- Item shapes of the device lists (needs an account with linked devices).
- Units and rounding of `value`, price fields and `householdPowerKw`.
- Whether the API rejects an old `x-app-version`.

_Last updated: 2026-10-31_
