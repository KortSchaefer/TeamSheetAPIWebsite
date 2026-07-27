from decimal import Decimal

from sqlalchemy.orm import Session

from app.models import InventoryBalance, InventoryItem, RecipeItem, StockMovement


def record_recipe_sale(db: Session, order_item_id: int, menu_item_id: int, quantity: int) -> list[StockMovement]:
    movements = []
    recipes = db.query(RecipeItem).filter(RecipeItem.menu_item_id == menu_item_id).all()
    for recipe in recipes:
        source_event_key = f"pos-order-item:{order_item_id}:ingredient:{recipe.ingredient_id}"
        existing = db.query(StockMovement).filter(StockMovement.source_event_key == source_event_key).first()
        if existing:
            movements.append(existing)
            continue
        inventory_item = (
            db.query(InventoryItem)
            .filter(
                InventoryItem.ingredient_id == recipe.ingredient_id,
                InventoryItem.active.is_(True),
            )
            .first()
        )
        quantity_change = -(Decimal(str(recipe.quantity)) * quantity)
        location_id = None
        if inventory_item and inventory_item.default_location_id:
            location_id = inventory_item.default_location_id
            balance = (
                db.query(InventoryBalance)
                .filter(
                    InventoryBalance.inventory_item_id == inventory_item.id,
                    InventoryBalance.location_id == location_id,
                )
                .first()
            )
            if balance is None:
                balance = InventoryBalance(
                    inventory_item_id=inventory_item.id,
                    location_id=location_id,
                    quantity_on_hand=0,
                )
                db.add(balance)
            balance.quantity_on_hand += quantity_change
        movement = StockMovement(
            ingredient_id=recipe.ingredient_id,
            inventory_item_id=inventory_item.id if inventory_item else None,
            location_id=location_id,
            quantity_change=float(quantity_change),
            reason="SALE",
            order_item_id=order_item_id,
            source_event_key=source_event_key,
        )
        db.add(movement)
        movements.append(movement)
    return movements
