"""Read-only connection check. Never prints the bearer credential."""
import argparse
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def load_credentials(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator:
            values[name.strip()] = value.strip().strip("\"'")
    token = values.get("WINDWARD_API_TOKEN", "")
    if not re.fullmatch(r"wwa_[a-f0-9]{32}_[A-Za-z0-9_-]{43}", token):
        raise ValueError(
            "Malformed token: copy WINDWARD_API_TOKEN from the original credential "
            "file. It must be 80 characters with no $, spaces, or line breaks."
        )
    base = values.get("WINDWARD_API_BASE_URL", "").rstrip("/")
    if base not in (
        "https://windward-service-api.windwardlabs.workers.dev/v1",
        "http://localhost:8787/v1",
    ):
        raise ValueError("Unexpected API URL; use the original credential file.")
    return base, token


def check(path):
    base, token = load_credentials(path)
    request = Request(
        base + "/me",
        headers={"Authorization": "Bearer " + token, "Accept": "application/json",
                 "User-Agent": "WindwardJames/1.0 (+https://windwardlabs.xyz)"},
    )
    try:
        response = urlopen(request, timeout=20)
    except HTTPError as error:
        response = error
    except URLError:
        print(json.dumps({"verified": False, "error": "Network connection failed before an HTTP response. Check sandbox outbound access, DNS, and TLS."}))
        return 1
    with response:
        raw = response.read(65536)
        result = {
            "httpStatus": response.status,
            "contentType": response.headers.get("Content-Type"),
            "cloudflareRayId": response.headers.get("CF-Ray"),
            "cloudflareMitigated": response.headers.get("CF-Mitigated"),
        }
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        body = None
    if isinstance(body, dict) and response.status == 200:
        result.update(verified=True, email=body.get("email"), scopes=body.get("scopes"), keyId=body.get("keyId"))
    elif isinstance(body, dict) and isinstance(body.get("error"), str):
        result.update(verified=False, error=body["error"][:300].replace(token, "[redacted]"))
    else:
        match = re.search(r"(?:Error\s*(?:code)?\s*[: ]\s*|error-code[^>]*>)(1\d{3})", raw.decode("utf-8", errors="replace"), re.IGNORECASE)
        result.update(verified=False, cloudflareErrorCode=match.group(1) if match else None,
                      error="Non-JSON response; the request may have been blocked before reaching the API.")
    print(json.dumps(result, indent=2))
    return 0 if result.get("verified") else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("credentials", help="Private James .env credential file")
    args = parser.parse_args()
    try:
        sys.exit(check(args.credentials))
    except (ValueError, OSError) as error:
        print(json.dumps({"verified": False, "error": str(error)}))
        sys.exit(1)
