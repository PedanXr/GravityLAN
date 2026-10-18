import pytest


@pytest.mark.asyncio
async def test_group_lifecycle_and_rename(client, admin_token):
    auth_headers = {"Authorization": f"Bearer {admin_token}"}

    # 1. Create a custom group
    create_res = await client.post(
        "/api/groups",
        json={"name": "Workstations", "icon": "monitor"},
        headers=auth_headers,
    )
    assert create_res.status_code == 201
    group_data = create_res.json()
    group_id = group_data["id"]
    assert group_data["name"] == "Workstations"

    # 2. Rename the group
    update_res = await client.patch(
        f"/api/groups/{group_id}",
        json={"name": "Client Workstations"},
        headers=auth_headers,
    )
    assert update_res.status_code == 200
    assert update_res.json()["name"] == "Client Workstations"

    # 3. Duplicate name check returns 409
    dup_res = await client.post(
        "/api/groups",
        json={"name": "Client Workstations"},
        headers=auth_headers,
    )
    assert dup_res.status_code == 409

    # 4. Renaming to existing name returns 409
    second_group_res = await client.post(
        "/api/groups",
        json={"name": "Office Laptops"},
        headers=auth_headers,
    )
    assert second_group_res.status_code == 201
    second_id = second_group_res.json()["id"]

    dup_rename_res = await client.patch(
        f"/api/groups/{second_id}",
        json={"name": "Client Workstations"},
        headers=auth_headers,
    )
    assert dup_rename_res.status_code == 409

    # 5. Empty name returns 400
    empty_rename_res = await client.patch(
        f"/api/groups/{second_id}",
        json={"name": "   "},
        headers=auth_headers,
    )
    assert empty_rename_res.status_code == 400

    # 6. Delete custom group
    del_res = await client.delete(f"/api/groups/{second_id}", headers=auth_headers)
    assert del_res.status_code == 204
