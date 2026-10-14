"""index.html must not be cached, otherwise browsers keep the previous release's UI."""

import app.main as main


async def test_root_index_is_served_with_no_cache(monkeypatch, tmp_path, client):
    (tmp_path / "index.html").write_text("<!doctype html><title>GravityLAN</title>")
    monkeypatch.setattr(main, "FRONTEND_DIR", tmp_path)

    response = await client.get("/")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert "GravityLAN" in response.text


# --- serve_spa path containment ------------------------------------------------

import pytest
from fastapi import HTTPException


@pytest.fixture
def frontend_dir(monkeypatch, tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>GravityLAN</title>")
    (static / "app.js").write_text("console.log('ok')")
    monkeypatch.setattr(main, "FRONTEND_DIR", static)
    return static


async def test_serve_spa_serves_files_and_falls_back_to_index(frontend_dir):
    asset = await main.serve_spa("app.js")
    assert asset.path == str(frontend_dir / "app.js")

    route = await main.serve_spa("settings/network")
    assert route.path == str(frontend_dir / "index.html")
    assert route.headers["cache-control"] == "no-cache"


async def test_serve_spa_rejects_sibling_dir_with_same_prefix(frontend_dir):
    """/app/static_other starts with /app/static but is outside it (reached here via a symlink)."""
    sibling = frontend_dir.parent / "static_other"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("token")
    try:
        (frontend_dir / "link").symlink_to(sibling, target_is_directory=True)
    except OSError as e:
        # Windows without admin rights or developer mode (WinError 1314); Linux CI runs it
        pytest.skip(f"cannot create symlinks here: {e}")

    with pytest.raises(HTTPException) as exc:
        await main.serve_spa("link/secret.txt")
    assert exc.value.status_code == 400


@pytest.mark.parametrize("path", ["../etc/passwd", "/etc/passwd", "a\\b"])
async def test_serve_spa_rejects_traversal(frontend_dir, path):
    with pytest.raises(HTTPException) as exc:
        await main.serve_spa(path)
    assert exc.value.status_code == 400
