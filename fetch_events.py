"""Collects upcoming events around London from Ticketmaster, Skiddle and
football-data.org and writes them to site/events.json for the app.

The API keys come from environment variables (stored as GitHub secrets):
TICKETMASTER_KEY, SKIDDLE_KEY, FOOTBALL_DATA_KEY.
"""

import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

DAYS_AHEAD = 180
OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "events.json")

# London plus places roughly two hours or less away by train.
# (name, latitude, longitude, search radius in miles)
AREAS = [
    ("London", 51.5074, -0.1278, 30),
    ("Brighton", 50.8225, -0.1372, 10),
    ("Oxford", 51.7520, -1.2577, 10),
    ("Cambridge", 52.2053, 0.1218, 10),
    ("Reading", 51.4543, -0.9781, 8),
    ("Canterbury", 51.2802, 1.0789, 10),
    ("Southampton", 50.9097, -1.4044, 8),
    ("Portsmouth", 50.8198, -1.0880, 8),
    ("Bath", 51.3811, -2.3590, 6),
    ("Bristol", 51.4545, -2.5879, 10),
    ("Birmingham", 52.4862, -1.8904, 12),
    ("Coventry", 52.4068, -1.5197, 6),
    ("Leicester", 52.6369, -1.1398, 8),
    ("Nottingham", 52.9548, -1.1581, 8),
    ("Ipswich", 52.0567, 1.1482, 6),
    ("Norwich", 52.6309, 1.2974, 8),
    ("Manchester", 53.4808, -2.2426, 12),
    ("Liverpool", 53.4084, -2.9916, 10),
]

# Place names seen in football stadium addresses that belong to one of the areas above.
TOWN_AREAS = {
    "Brentford": "London",
    "Watford": "London",
    "Luton": "London",
    "Hove": "Brighton",
    "West Bromwich": "Birmingham",
    "Wolverhampton": "Birmingham",
    **{name: name for name, *_ in AREAS},
}

# Listings that aren't really events.
JUNK = re.compile(
    r"parking|car park|season ticket|membership|gift ?card|voucher|add-on|upgrade|"
    r"shuttle|coach (travel|trip)|locker|merchandise|package only|"
    r"standard (entry|experience)|fast track|annual pass",
    re.I,
)

TM_KEY = os.environ.get("TICKETMASTER_KEY", "")
SK_KEY = os.environ.get("SKIDDLE_KEY", "")
FD_KEY = os.environ.get("FOOTBALL_DATA_KEY", "")


def get_json(url, params=None, headers=None, tries=4):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "london-events/1.0", **(headers or {})})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(15 if "football-data" in url else 2 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < tries - 1:
                time.sleep(3)
                continue
            raise


def nearest_area(lat, lon, fallback):
    if lat is None or lon is None:
        return fallback

    def dist(area):
        _, alat, alon, _ = area
        dx = (lon - alon) * math.cos(math.radians(lat))
        return dx * dx + (lat - alat) ** 2

    return min(AREAS, key=dist)[0]


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- Ticketmaster

TM_URL = "https://app.ticketmaster.com/discovery/v2/events.json"
TM_SEGMENTS = {
    "KZFzniwnSyZfZ7v7nJ": "Music",
    "KZFzniwnSyZfZ7v7na": "Arts & Theatre",
    "KZFzniwnSyZfZ7v7nE": "Sports",
}


def tm_category(segment, genre, subgenre, name):
    if segment == "Sports":
        return "football" if genre == "Soccer" else "sport"
    if genre in ("Classical", "Opera", "Dance") or "opera" in subgenre.lower() or "ballet" in name.lower():
        return "classical"
    if segment == "Music":
        return "concerts"
    if genre == "Comedy":
        return "comedy"
    if genre == "Fine Art":
        return None
    return "theatre"


def tm_image(images):
    wide = [i for i in images if i.get("ratio") == "16_9" and not i.get("fallback")] or images
    if not wide:
        return ""
    return min(wide, key=lambda i: abs(i.get("width", 0) - 640)).get("url", "")


def tm_event(e, area):
    name = (e.get("name") or "").strip()
    dates = e.get("dates", {})
    start = dates.get("start", {})
    if not name or JUNK.search(name) or dates.get("status", {}).get("code") in ("cancelled", "postponed"):
        return None
    if start.get("dateTBA") or start.get("dateTBD") or not start.get("localDate"):
        return None

    c = (e.get("classifications") or [{}])[0]
    segment, genre, subgenre = (c.get(k, {}).get("name", "") for k in ("segment", "genre", "subGenre"))
    cat = tm_category(segment, genre, subgenre, name)
    if not cat:
        return None

    venue = (e.get("_embedded", {}).get("venues") or [{}])[0]
    loc = venue.get("location", {})
    lat, lon = to_float(loc.get("latitude")), to_float(loc.get("longitude"))
    prices = [p["min"] for p in e.get("priceRanges", []) if p.get("min")]
    t = "" if start.get("noSpecificTime") else (start.get("localTime") or "")[:5]
    label = next((g for g in (subgenre, genre) if g and g not in ("Undefined", "Other", "Miscellaneous")), "")

    return {
        "id": "tm" + e["id"],
        "title": name,
        "cat": cat,
        "genre": label,
        "venue": venue.get("name", ""),
        "area": nearest_area(lat, lon, area),
        "when": start["localDate"] + ("T" + t if t else ""),
        "url": e.get("url", ""),
        "img": tm_image(e.get("images", [])),
        "price": min(prices) if prices else None,
        "src": "Ticketmaster",
    }


def tm_fetch(area, segment, start, end, out):
    """Ticketmaster only pages through the first 1000 results, so busy date
    ranges are split in half until each piece fits."""
    name, lat, lon, radius = area
    params = {
        "apikey": TM_KEY,
        "latlong": f"{lat},{lon}",
        "radius": radius,
        "unit": "miles",
        "countryCode": "GB",
        "segmentId": segment,
        "locale": "*",
        "size": 200,
        "sort": "date,asc",
        "startDateTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endDateTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    page = 0
    while True:
        data = get_json(TM_URL, {**params, "page": page})
        time.sleep(0.25)  # stay under 5 requests a second
        info = data.get("page", {})
        if page == 0 and info.get("totalElements", 0) > 1000 and end - start > timedelta(days=1):
            mid = (start + (end - start) / 2).replace(microsecond=0)
            tm_fetch(area, segment, start, mid, out)
            tm_fetch(area, segment, mid, end, out)
            return
        for e in data.get("_embedded", {}).get("events", []):
            ev = tm_event(e, name)
            if ev:
                out[ev["id"]] = ev
        page += 1
        if page >= info.get("totalPages", 0) or page * 200 >= 1000:
            return


def ticketmaster():
    out = {}
    start = datetime.now(timezone.utc).replace(microsecond=0)
    end = start + timedelta(days=DAYS_AHEAD)
    for area in AREAS:
        for segment in TM_SEGMENTS:
            tm_fetch(area, segment, start, end, out)
    return list(out.values())


# --------------------------------------------------------------------- Skiddle

SK_URL = "https://www.skiddle.com/api/v1/events/search/"
SK_CODES = {"LIVE": "concerts", "THEATRE": "theatre", "COMEDY": "comedy"}


def sk_event(r, cat, area):
    name = (r.get("eventname") or "").strip()
    if not name or JUNK.search(name) or str(r.get("cancelled", "0")) not in ("0", ""):
        return None
    genres = [g.get("name", "") for g in r.get("genres") or []]
    if cat == "concerts" and re.search(r"classical|opera|ballet", " ".join(genres), re.I):
        cat = "classical"

    venue = r.get("venue") or {}
    lat, lon = to_float(venue.get("latitude")), to_float(venue.get("longitude"))
    # Skiddle labels local times as +00:00, so the clock time is used as-is.
    t = (r.get("startdate") or "")[11:16]
    price = (r.get("ticketpricing") or {}).get("minPrice")
    if price is None:
        m = re.search(r"\d+(\.\d+)?", r.get("entryprice") or "")
        price = float(m.group()) if m else None

    return {
        "id": "sk" + str(r["id"]),
        "title": name,
        "cat": cat,
        "genre": genres[0] if genres else "",
        "venue": venue.get("name", ""),
        "area": nearest_area(lat, lon, area),
        "when": r["date"] + ("T" + t if t else ""),
        "url": r.get("link", ""),
        "img": r.get("largeimageurl") or r.get("imageurl") or "",
        "price": price,
        "src": "Skiddle",
    }


def skiddle():
    out = {}
    today = datetime.now(timezone.utc).date()
    for name, lat, lon, radius in AREAS:
        for code, cat in SK_CODES.items():
            offset = 0
            while True:
                data = get_json(SK_URL, {
                    "api_key": SK_KEY,
                    "latitude": lat,
                    "longitude": lon,
                    "radius": radius,
                    "eventcode": code,
                    "minDate": today.isoformat(),
                    "maxDate": (today + timedelta(days=DAYS_AHEAD)).isoformat(),
                    "limit": 100,
                    "offset": offset,
                    "order": "date",
                    "description": 0,
                })
                time.sleep(0.3)
                results = data.get("results") or []
                for r in results:
                    ev = sk_event(r, cat, name)
                    if ev:
                        out[ev["id"]] = ev
                offset += 100
                if not results or offset >= int(data.get("totalcount") or 0):
                    break
    return list(out.values())


# ---------------------------------------------------------------- football-data

FD_URL = "https://api.football-data.org/v4"
FD_COMPS = {"PL": "Premier League", "ELC": "Championship", "CL": "Champions League"}


def town_area(address):
    for town, area in TOWN_AREAS.items():
        if re.search(r"\b" + re.escape(town) + r"\b", address):
            return area
    return None


def uk_local(dt):
    """UTC -> UK clock time (British Summer Time runs from the last Sunday of
    March to the last Sunday of October, switching at 01:00 UTC)."""
    def last_sunday(month):
        d = datetime(dt.year, month + 1, 1, 1, tzinfo=timezone.utc) - timedelta(days=1)
        return d - timedelta(days=(d.weekday() + 1) % 7)

    return dt + timedelta(hours=1) if last_sunday(3) <= dt < last_sunday(10) else dt


def football():
    out = []
    headers = {"X-Auth-Token": FD_KEY}
    now = datetime.now(timezone.utc)
    for code, comp in FD_COMPS.items():
        # The free plan allows 10 requests a minute.
        teams = {t["id"]: t for t in get_json(f"{FD_URL}/competitions/{code}/teams", headers=headers)["teams"]}
        time.sleep(7)
        matches = get_json(f"{FD_URL}/competitions/{code}/matches", headers=headers)["matches"]
        time.sleep(7)
        for m in matches:
            if m.get("status") not in ("SCHEDULED", "TIMED"):
                continue
            home = teams.get(m["homeTeam"]["id"])
            area = home and town_area(home.get("address") or "")
            kickoff = datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00"))
            if not area or kickoff < now:
                continue
            ev = {
                "id": f"fd{m['id']}",
                "title": f"{m['homeTeam']['shortName']} vs {m['awayTeam']['shortName']}",
                "cat": "football",
                "genre": comp,
                "venue": home.get("venue") or "",
                "area": area,
                "when": uk_local(kickoff).strftime("%Y-%m-%dT%H:%M"),
                "url": home.get("website") or "",
                "img": home.get("crest") or "",
                "price": None,
                "src": "football-data.org",
            }
            if m["status"] == "SCHEDULED":  # kick-off time not confirmed yet
                ev["tbc"] = True
            out.append(ev)
    return out


# ------------------------------------------------------------------------ main

def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def build(events):
    """Drops duplicates and groups repeat performances (e.g. a West End show
    running every night) into one entry with a list of dates."""
    today = datetime.now(timezone.utc).date().isoformat()
    tm_keys = {(norm(e["title"])[:25], e["when"][:10]) for e in events if e["src"] == "Ticketmaster"}
    groups = {}
    for e in sorted(events, key=lambda e: e["when"]):
        if e["when"][:10] < today:
            continue
        if e["src"] == "Skiddle" and (norm(e["title"])[:25], e["when"][:10]) in tm_keys:
            continue
        key = (norm(e["title"]), norm(e["venue"]))
        g = groups.get(key)
        if not g:
            g = groups[key] = {
                "id": e["id"], "t": e["title"], "c": e["cat"], "g": e["genre"], "v": e["venue"],
                "a": e["area"], "img": e["img"], "p": e["price"], "s": e["src"], "d": [],
            }
        elif e["price"] is not None and (g["p"] is None or e["price"] < g["p"]):
            g["p"] = e["price"]
        if g["d"] and g["d"][-1][0] == e["when"]:
            continue
        g["d"].append([e["when"], e["url"]] + ([1] if e.get("tbc") else []))
    return sorted(groups.values(), key=lambda g: g["d"][0][0])


def main():
    events = []
    for name, source in (("Ticketmaster", ticketmaster), ("Skiddle", skiddle), ("football-data.org", football)):
        started = time.time()
        try:
            found = source()
            print(f"{name}: {len(found)} events ({time.time() - started:.0f}s)")
            events += found
        except Exception as e:  # one source failing shouldn't take the others down
            print(f"{name} FAILED: {e!r}")

    groups = build(events)
    print(f"Total after grouping: {len(groups)}")
    if len(groups) < 100:
        sys.exit("Too few events - something is wrong, not publishing.")

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "areas": [a[0] for a in AREAS],
            "events": groups,
        }, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
