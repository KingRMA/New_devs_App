# DESIGN.md - Property Revenue Dashboard Bug Investigation

## Assignment Summary

This is a **debugging exercise** for an existing multi-tenant property management revenue dashboard. Three bugs were reported by clients and the finance team. The task is to identify root causes and apply surgical fixes -- not rebuild the system.

## System Architecture

```
Frontend (React/Vite/TS :3000) --> Backend (FastAPI :8000) --> PostgreSQL (:5432)
                                            |
                                            +--> Redis (:6379) - revenue cache
```

- **Multi-tenant**: Tenants `tenant-a` (Sunset Properties) and `tenant-b` (Ocean Rentals)
- **Properties table**: Composite PK `(id, tenant_id)` -- the same property `id` can exist under different tenants
- **Reservations table**: `total_amount NUMERIC(10, 3)` -- sub-cent precision (3 decimal places)
- **Caching**: Redis for revenue summaries (5-min TTL), plus frontend in-memory SecureAPI request cache (5s TTL)
- **Auth**: JWT tokens via Supabase or custom HS256, with tenant resolution via `TenantResolver`

## Seed Data (Ground Truth)

**Tenant A (Sunset Properties):**

| Property | Reservations | Expected Total |
|----------|-------------|----------------|
| prop-001 (Beach House Alpha) | 1250.000 + 333.333 + 333.333 + 333.334 | **2,250.000** |
| prop-002 (City Apartment Downtown) | 1250.00 + 1475.50 + 1199.25 + 1050.75 | **4,975.50** |
| prop-003 (Country Villa Estate) | 2850.00 + 3250.50 | **6,100.50** |

**Tenant B (Ocean Rentals):**

| Property | Reservations | Expected Total |
|----------|-------------|----------------|
| prop-001 (Mountain Lodge Beta) | *(no reservations in seed)* | **0.00** |
| prop-004 (Lakeside Cottage) | 420.00 + 560.75 + 480.25 + 315.50 | **1,776.50** |
| prop-005 (Urban Loft Modern) | 920.00 + 1080.40 + 1255.60 | **3,256.00** |

Note: `prop-001` exists under **both** tenants with different names and data. This is the key setup that exposes the cache bug.

## Bugs Identified

### Bug 1: Cross-Tenant Data Leakage (CRITICAL - Privacy/Security)

**Reported by**: Client B (Ocean Rentals) -- "sometimes when we refresh the page, we see revenue numbers that look like they belong to another company"

**Root cause**: `backend/app/services/cache.py:13`

```python
cache_key = f"revenue:{property_id}"  # BUG: missing tenant_id!
```

The Redis cache key is `revenue:{property_id}` with **no tenant isolation**. Since `prop-001` exists for both tenants:
1. Tenant A requests `prop-001` -> cache MISS -> fetches from DB (tenant-a data: $2,250) -> stores as `revenue:prop-001`
2. Tenant B requests `prop-001` -> cache HIT -> returns tenant-a's $2,250 instead of tenant-b's $0.00
3. On next refresh, whichever tenant hits first poisons the cache for the other

**Fix**: Include `tenant_id` in the cache key: `revenue:{tenant_id}:{property_id}`

**Severity**: CRITICAL -- financial data leaking between organizations

---

### Bug 2: Revenue Totals Don't Match Client Records (Data Accuracy)

**Reported by**: Client A (Sunset Properties) -- "revenue numbers don't match our internal records for March"

**Root causes** (multiple contributing factors):

#### 2a. Mock data fallback has wrong values
`backend/app/services/reservations.py:93-99`

```python
mock_data = {
    'prop-001': {'total': '1000.00', 'count': 3},   # WRONG: seed data sums to 2250.000
    'prop-002': {'total': '4975.50', 'count': 4},    # Correct
    'prop-003': {'total': '6100.50', 'count': 2},    # Correct
    'prop-004': {'total': '1776.50', 'count': 4},    # Correct
    'prop-005': {'total': '3256.00', 'count': 3}     # Correct
}
```

When the DB connection fails (which happens easily given the `DatabasePool` initialization), the fallback returns **hardcoded mock data**. For `prop-001` (tenant-a), the mock says `1000.00` but the real seed data sums to `2250.000` -- a $1,250 discrepancy. This mock data also has no tenant awareness: it returns the same values regardless of which tenant is asking.

#### 2b. Dashboard shows all properties to all tenants
`frontend/src/components/Dashboard.tsx:4-9`

```typescript
const PROPERTIES = [
  { id: 'prop-001', name: 'Beach House Alpha' },
  { id: 'prop-002', name: 'City Apartment Downtown' },
  { id: 'prop-003', name: 'Country Villa Estate' },
  { id: 'prop-004', name: 'Lakeside Cottage' },
  { id: 'prop-005', name: 'Urban Loft Modern' }
];
```

All 5 properties are hardcoded and shown to every tenant. Tenant A sees tenant-b-only properties (prop-004, prop-005) and vice versa. Combined with Bug 1's cache poisoning, this makes the numbers look completely wrong.

#### 2c. Timezone boundary issue (latent)
`backend/app/services/reservations.py:10`

The `calculate_monthly_revenue` function uses naive UTC boundaries (`datetime(year, month, 1)`) without timezone conversion. Reservation `res-tz-1` has `check_in_date = '2024-02-29 23:30:00+00'` which is Feb 29 in UTC but March 1 in Europe/Paris. This function isn't called by the main dashboard endpoint (which does all-time sums), but it would break any monthly reporting.

**Fix**:
- Fix mock data values to match seed data
- Make mock data tenant-aware
- Filter property list by tenant in the dashboard
- (Bonus) Fix timezone handling in monthly revenue

---

### Bug 3: Revenue Off by a Few Cents (Precision)

**Reported by**: Finance team -- "revenue totals seem slightly off by a few cents here and there"

**Root cause**: `backend/app/api/v1/dashboard.py:19`

```python
total_revenue_float = float(revenue_data['total'])  # BUG: Decimal -> float loses precision
```

The data flows correctly as Decimal/string through the DB and service layers, but the dashboard endpoint converts to `float` right before returning, introducing IEEE 754 floating-point errors.

The seed data is deliberately constructed to trigger this: `prop-001` has three reservations of `333.333 + 333.333 + 333.334`. In Decimal arithmetic this is exactly `1000.000`, but `float` conversion can produce `999.9999999999999` or similar.

Additionally, the frontend (`RevenueSummary.tsx:64`) does its own rounding:
```typescript
const displayTotal = Math.round(data.total_revenue * 100) / 100;
```
This compounds the precision loss from the backend's float conversion.

**Fix**: Use `Decimal.quantize` to round to 2 decimal places on the backend, then return as a properly rounded float (or string). This prevents the cascading precision loss.

---

## Fix Plan

### Fix 1: Tenant-aware cache key (`cache.py`)
- Change `f"revenue:{property_id}"` to `f"revenue:{tenant_id}:{property_id}"`
- 1-line change, eliminates cross-tenant leakage

### Fix 2: Fix precision loss (`dashboard.py`)
- Replace `float(revenue_data['total'])` with `float(Decimal(revenue_data['total']).quantize(Decimal('0.01')))`
- Rounds to 2 decimal places using exact Decimal math before converting to float for JSON

### Fix 3: Fix mock data (`reservations.py`)
- Correct `prop-001` mock total from `1000.00` to `2250.000`
- Add tenant-awareness to mock fallback so each tenant gets their own data

### Fix 4: Tenant-scoped property list (`Dashboard.tsx`)
- Filter the property list based on the authenticated user's tenant
- Or fetch from the backend API which already has tenant isolation

### Fix 5 (bonus): Timezone-aware monthly revenue (`reservations.py`)
- Convert date boundaries to the property's timezone before querying
- Not actively breaking the dashboard summary but would break monthly reports

## Files to Modify

| File | Bug | Change |
|------|-----|--------|
| `backend/app/services/cache.py` | 1 | Add `tenant_id` to Redis cache key |
| `backend/app/api/v1/dashboard.py` | 3 | Use `Decimal.quantize` instead of raw `float()` |
| `backend/app/services/reservations.py` | 2a | Fix mock data values + add tenant awareness |
| `frontend/src/components/Dashboard.tsx` | 2b | Filter property list by tenant |

## Verification Plan

After fixes, verify:
1. Log in as Sunset Properties -> see only prop-001/002/003 with correct totals
2. Log in as Ocean Rentals -> see only prop-001/004/005 with correct totals
3. Refresh repeatedly -> no cross-tenant data leakage
4. Revenue totals match seed data exactly (to 2 decimal places)
5. No floating-point artifacts in displayed amounts

