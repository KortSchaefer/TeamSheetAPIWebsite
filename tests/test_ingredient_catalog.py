from decimal import Decimal

import pytest

from app.models import (
    Ingredient,
    IngredientLineage,
    InventoryBalance,
    InventoryItem,
    InventoryItemAlias,
    InventoryLocation,
    MenuItem,
    RecipeItem,
    StockMovement,
    UserRole,
)
from app.services.ingredient_catalog import import_default_catalog
from app.services.inventory_events import record_recipe_sale


async def login_manager(client):
    email = "catalog-manager@example.com"
    await client.post(
        "/auth/register",
        json={
            "email": email,
            "password": "secret123",
            "full_name": "Catalog Manager",
            "role": UserRole.MANAGER.value,
        },
    )
    response = await client.post(
        "/auth/login",
        json={"email": email, "password": "secret123"},
    )
    return response.json()["access_token"]


def test_default_catalog_import_is_complete_and_idempotent(TestingSessionLocal):
    with TestingSessionLocal() as db:
        first = import_default_catalog(db)
        second = import_default_catalog(db)

        assert first["item_count"] == 420
        assert first["relationship_count"] == 529
        assert second["created"] == 0
        assert second["updated"] == 0
        assert second["unchanged"] == 420
        assert db.query(Ingredient).filter(Ingredient.external_id.is_not(None)).count() == 420
        assert db.query(IngredientLineage).count() == 529

        mustard = db.query(Ingredient).filter(Ingredient.external_id == "yellow_mustard").one()
        parent_ids = [
            link.parent.external_id
            for link in sorted(mustard.parent_links, key=lambda link: link.order_index)
        ]
        assert parent_ids == ["mustard_powder", "vinegar", "water", "salt"]

        razzlesnake = (
            db.query(Ingredient)
            .filter(Ingredient.external_id == "razzlesnake_margarita")
            .one()
        )
        assert razzlesnake.name == "Razzlesnake Margarita"
        assert "Razzle Snake" in razzlesnake.source_correction

        grand_marnier = (
            db.query(Ingredient)
            .filter(Ingredient.external_id == "grand_marnier_liqueur")
            .one()
        )
        assert grand_marnier.category == "Liqueurs"
        assert grand_marnier.catalog_metadata["stockable"] is True


@pytest.mark.asyncio
async def test_catalog_search_detail_and_inventory_activation(client):
    token = await login_manager(client)
    headers = {"Authorization": f"Bearer {token}"}

    imported = await client.post("/ingredient-catalog/import-default", headers=headers)
    assert imported.status_code == 200, imported.text
    assert imported.json()["item_count"] == 420

    metadata = await client.get("/ingredient-catalog/metadata", headers=headers)
    assert metadata.status_code == 200, metadata.text
    assert len(metadata.json()["stage_definitions"]) == 9
    assert len(metadata.json()["items_requiring_store_confirmation"]) == 15
    assert metadata.json()["relationship_rules"]["parent_ids"].startswith("Immediate")

    search = await client.get(
        "/ingredient-catalog?search=prime%20rib&limit=5",
        headers=headers,
    )
    assert search.status_code == 200, search.text
    assert search.json()["total"] >= 5
    assert len(search.json()["items"]) == 5

    detail = await client.get("/ingredient-catalog/prime_rib_log", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["parent_ids"] == ["rib_subprimal", "prime_rib_seasoning"]

    location = await client.post(
        "/inventory/locations",
        json={"name": "Catalog Walk-in"},
        headers=headers,
    )
    assert location.status_code == 201, location.text
    activation_payload = {
        "catalog_id": "chicken_breast",
        "base_unit": "lb",
        "default_location_id": location.json()["id"],
        "purchase_unit": "case",
        "purchase_to_base": 40,
    }
    activated = await client.post(
        "/inventory/items/from-catalog",
        json=activation_payload,
        headers=headers,
    )
    repeated = await client.post(
        "/inventory/items/from-catalog",
        json=activation_payload,
        headers=headers,
    )
    assert activated.status_code == 201, activated.text
    assert repeated.status_code == 201, repeated.text
    assert repeated.json()["id"] == activated.json()["id"]
    assert activated.json()["ingredient_id"] is not None

    linked_detail = await client.get(
        "/ingredient-catalog/chicken_breast",
        headers=headers,
    )
    assert linked_detail.json()["activated_inventory_item_id"] == activated.json()["id"]


@pytest.mark.asyncio
async def test_bar_inventory_activation_only_creates_countable_products(
    client, TestingSessionLocal
):
    token = await login_manager(client)
    headers = {"Authorization": f"Bearer {token}"}

    first = await client.post(
        "/ingredient-catalog/import-bar-inventory",
        headers=headers,
    )
    second = await client.post(
        "/ingredient-catalog/import-bar-inventory",
        headers=headers,
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["stockable_item_count"] == 117
    assert first.json()["created"] == 117
    assert second.json()["created"] == 0
    assert second.json()["updated"] == 0

    items = await client.get("/inventory/items?active=true", headers=headers)
    assert items.status_code == 200, items.text
    names = {item["name"] for item in items.json()}
    assert "Monin Mango Syrup" in names
    assert "Bud Light Draft Keg" in names
    assert "La Marca Prosecco 187 mL Bottle" in names
    assert "House Margarita" not in names
    assert "Barefoot Moscato Glass" not in names
    budweiser_bottles = next(
        item for item in items.json() if item["name"] == "Budweiser Beer Bottles"
    )
    assert budweiser_bottles["base_unit"] == "bottle"
    assert budweiser_bottles["purchase_unit"] == "bottle"
    assert budweiser_bottles["purchase_to_base"] == "1.0000"

    with TestingSessionLocal() as db:
        mello_yello = (
            db.query(InventoryItem)
            .filter(InventoryItem.name == "Mello Yello Fountain Syrup")
            .one()
        )
        aliases = {
            alias.normalized_alias
            for alias in db.query(InventoryItemAlias)
            .filter(InventoryItemAlias.inventory_item_id == mello_yello.id)
            .all()
        }
        assert "mellow yellow" in aliases


def test_recipe_sale_depletes_activated_inventory_exactly_once(TestingSessionLocal):
    with TestingSessionLocal() as db:
        import_default_catalog(db)
        ingredient = (
            db.query(Ingredient)
            .filter(Ingredient.external_id == "eight_oz_salmon")
            .one()
        )
        location = InventoryLocation(name="POS Depletion Cooler")
        db.add(location)
        db.flush()
        inventory_item = InventoryItem(
            ingredient_id=ingredient.id,
            name=ingredient.name,
            category=ingredient.category,
            base_unit="portion",
            default_location_id=location.id,
        )
        menu_item = MenuItem(name="8 oz Salmon Dinner", price_cents=2499)
        db.add_all([inventory_item, menu_item])
        db.flush()
        db.add(
            InventoryBalance(
                inventory_item_id=inventory_item.id,
                location_id=location.id,
                quantity_on_hand=Decimal("10"),
            )
        )
        db.add(
            RecipeItem(
                menu_item_id=menu_item.id,
                ingredient_id=ingredient.id,
                quantity=1,
            )
        )
        db.commit()

        first = record_recipe_sale(db, order_item_id=9001, menu_item_id=menu_item.id, quantity=2)
        db.commit()
        second = record_recipe_sale(db, order_item_id=9001, menu_item_id=menu_item.id, quantity=2)
        db.commit()

        balance = (
            db.query(InventoryBalance)
            .filter(
                InventoryBalance.inventory_item_id == inventory_item.id,
                InventoryBalance.location_id == location.id,
            )
            .one()
        )
        assert balance.quantity_on_hand == Decimal("8.0000")
        assert second[0].id == first[0].id
        assert (
            db.query(StockMovement)
            .filter(StockMovement.source_event_key == "pos-order-item:9001:ingredient:" + str(ingredient.id))
            .count()
            == 1
        )
