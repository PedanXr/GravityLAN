"""Router-level auth (defense in depth) and input validation for values that reach shells.

server.url is embedded into the root agent install script; dns.server / a subnet's
dns_server is passed to `nmap --dns-servers`. Both must be rejected unless they are
plain values.
"""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.api import devices as devices_api
from app.api import topology as topology_api
from app.api.auth import get_current_admin
from app.database import get_db
from app.models.setting import Setting
from app.schemas.network import normalize_dns_server


def _admin_headers(token):
    return {"Authorization": f"Bearer {token}"}


# --- 1. Router-level authentication ------------------------------------------

@pytest.mark.parametrize("router", [
    devices_api.router,
    devices_api.router_services,
    devices_api.groups_router,
    topology_api.router,
])
def test_routers_require_admin_dependency(router):
    assert any(dep.dependency is get_current_admin for dep in router.dependencies)


@pytest.mark.asyncio
@pytest.mark.parametrize("router, path", [
    (devices_api.router, "/api/devices"),
    (devices_api.groups_router, "/api/groups"),
    (topology_api.router, "/api/topology/map"),
])
async def test_routers_reject_anonymous_even_without_include_dependencies(db, admin_token, router, path):
    """A router mounted without dependencies (e.g. a future main.py refactor) stays closed."""
    bare_app = FastAPI()
    bare_app.include_router(router)

    async def override_get_db():
        yield db

    bare_app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(transport=ASGITransport(app=bare_app), base_url="http://test") as ac:
        anonymous = await ac.get(path)
        authorized = await ac.get(path, headers=_admin_headers(admin_token))

    assert anonymous.status_code == 401
    assert authorized.status_code == 200


# --- 2a. server.url -----------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "http://192.168.1.100:8000",
    "https://gravity.example",
    "http://gravity.local:8000/",
    "https://gravity.example/sub/path",
])
async def test_server_url_accepts_plain_urls(client, admin_token, url):
    response = await client.post("/api/settings", json={"server.url": url}, headers=_admin_headers(admin_token))
    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    'http://h"; touch /tmp/x; echo "',
    "http://h:8000/$(id)",
    "http://h:8000/`id`",
    "http://h;id",
    "http://h&id",
    "http://h|id",
    "http://h:8000\nid",
    "http://h:8000\rid",
    "http://h'x",
    "http://h:8000?x=1",
    "http://h:8000/#frag",
    "http://user:pass@h:8000",
    "http://h_x:8000",
    "http://h:99999",
    "http://h:abc",
    "javascript://h",
])
async def test_server_url_rejects_shell_and_url_tricks(client, admin_token, url):
    response = await client.post("/api/settings", json={"server.url": url}, headers=_admin_headers(admin_token))
    assert response.status_code == 400
    assert "Invalid server URL" in response.json()["detail"]


# --- 2b. dns.server / dns_server --------------------------------------------

@pytest.mark.parametrize("value, expected", [
    (None, None),
    ("", None),
    ("   ", None),
    ("1.1.1.1", "1.1.1.1"),
    (" 192.168.1.1 ", "192.168.1.1"),
    ("2001:4860:4860::8888", "2001:4860:4860::8888"),
])
def test_normalize_dns_server_accepts_ips_and_empty(value, expected):
    assert normalize_dns_server(value) == expected


@pytest.mark.parametrize("value", [
    "8.8.8.8 --script=evil",
    "--script=evil",
    "-oN/tmp/x",
    "8.8.8.8,1.1.1.1",
    "dns.google",
    "1.1.1.1; id",
    "999.1.1.1",
])
def test_normalize_dns_server_rejects_non_ips(value):
    with pytest.raises(ValueError):
        normalize_dns_server(value)


@pytest.mark.asyncio
async def test_settings_dns_server_validated(client, db, admin_token):
    bad = await client.post("/api/settings", json={"dns.server": "--script=evil"}, headers=_admin_headers(admin_token))
    assert bad.status_code == 400
    assert "Invalid DNS server" in bad.json()["detail"]

    good = await client.post("/api/settings", json={"dns.server": "192.168.1.1"}, headers=_admin_headers(admin_token))
    assert good.status_code == 200

    # Empty keeps meaning "no custom DNS server"
    empty = await client.post("/api/settings", json={"dns.server": ""}, headers=_admin_headers(admin_token))
    assert empty.status_code == 200


@pytest.mark.asyncio
async def test_setup_complete_rejects_invalid_dns_server(client, db):
    response = await client.post("/api/setup/complete", json={"dns_server": "8.8.8.8 --script=evil"})
    assert response.status_code == 422

    # Nothing was persisted, setup is still open
    done = (await db.execute(select(Setting).where(Setting.key == "setup.complete"))).scalar_one_or_none()
    assert done is None


@pytest.mark.asyncio
async def test_setup_complete_stores_normalized_dns_server(client, db):
    response = await client.post("/api/setup/complete", json={"dns_server": " 192.168.1.1 "})
    assert response.status_code == 200
    dns = (await db.execute(select(Setting).where(Setting.key == "dns.server"))).scalar_one()
    assert dns.value == "192.168.1.1"


@pytest.mark.asyncio
async def test_subnet_dns_server_validated(client, db, admin_token):
    from app.api import network as network_api
    from app.main import app

    # network.py declares its own get_db; point it at the test database too
    async def override_network_db():
        yield db

    app.dependency_overrides[network_api.get_db] = override_network_db
    headers = _admin_headers(admin_token)
    bad = await client.post(
        "/api/network/subnets",
        json={"cidr": "10.0.0.0/24", "name": "Lab", "dns_server": "1.1.1.1; id"},
        headers=headers,
    )
    assert bad.status_code == 422

    created = await client.post(
        "/api/network/subnets",
        json={"cidr": "10.0.0.0/24", "name": "Lab", "dns_server": ""},
        headers=headers,
    )
    assert created.status_code == 200
    assert created.json()["dns_server"] is None
    subnet_id = created.json()["id"]

    bad_patch = await client.patch(f"/api/network/subnets/{subnet_id}", json={"dns_server": "-oN/tmp/x"}, headers=headers)
    assert bad_patch.status_code == 422

    good_patch = await client.patch(f"/api/network/subnets/{subnet_id}", json={"dns_server": "10.0.0.53"}, headers=headers)
    assert good_patch.status_code == 200
    assert good_patch.json()["dns_server"] == "10.0.0.53"
