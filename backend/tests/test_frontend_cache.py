"""index.html must not be cached, otherwise browsers keep the previous release's UI."""

import app.main as main


async def test_root_index_is_served_with_no_cache(monkeypatch, tmp_path, client):
    (tmp_path / "index.html").write_text("<!doctype html><title>GravityLAN</title>")
    monkeypatch.setattr(main, "FRONTEND_DIR", tmp_path)

    response = await client.get("/")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert "GravityLAN" in response.text
