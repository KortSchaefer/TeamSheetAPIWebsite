import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.database import Base, SessionLocal, engine, ensure_sqlite_sections_columns
from app.models import MenuCategory, MenuItem


RAW_MENU = """
Category,Item,Size/Variant,Price_USD
Steaks,Hand-Cut Sirloin,6 oz,13.49
Steaks,Hand-Cut Sirloin,8 oz,15.99
Steaks,Hand-Cut Sirloin,11 oz,18.99
Steaks,Hand-Cut Sirloin,16 oz,22.99
Steaks,Ft. Worth Ribeye,12 oz,22.99
Steaks,Ft. Worth Ribeye,14 oz,25.49
Steaks,Ft. Worth Ribeye,16 oz,27.99
Steaks,Bone-In Ribeye,20 oz,29.99
Steaks,New York Strip,8 oz Thick Cut,17.49
Steaks,New York Strip,12 oz Traditional Cut,21.99
Steaks,Porterhouse T-Bone,23 oz,33.99
Steaks,Dallas Filet,6 oz,21.99
Steaks,Dallas Filet,8 oz,24.99
Steaks,Filet Medallions,9 oz total,21.99
Steaks,Road Kill,,12.49
Steaks,Steak Kabob,,14.49
Steaks,Prime Rib,12 oz,23.99
Steaks,Prime Rib,14 oz,26.49
Steaks,Prime Rib,16 oz,28.99
Steak Add-ons,Smother Your Steak (add-on),Sauteed Mushrooms/Sauteed Onions/Jack Cheese/Brown Gravy,2.29

Ribs,Ribs,Half Slab,17.99
Ribs,Ribs,Full Slab,22.99

Combos,Sirloin & Grilled Shrimp,6 oz sirloin,19.99
Combos,Sirloin & Ribs,6 oz sirloin,21.99
Combos,Sirloin & Grilled Shrimp,8 oz sirloin,21.99
Combos,Sirloin & Ribs,8 oz sirloin,23.99
Combos,Ribeye & Grilled Shrimp,12 oz ribeye,27.99
Combos,Ribeye & Ribs,12 oz ribeye,29.99
Combos,Grilled BBQ Chicken & Sirloin,6 oz sirloin,21.99
Combos,Grilled BBQ Chicken & Ribs,,19.99
Combos,Filet & Grilled Shrimp,6 oz filet,26.99
Combos,Filet & Ribs,6 oz filet,28.99

Chicken Entrees,Grilled BBQ Chicken,,13.49
Chicken Entrees,Herb Crusted Chicken,,14.49
Chicken Entrees,Country Fried Chicken,,14.49
Chicken Entrees,Chicken Critters Dinner,,13.49
Chicken Entrees,Smothered Chicken,,14.49
Chicken Entrees,Portobello Mushroom Chicken,,14.99

Pork/Other Entrees,Pulled Pork Dinner,,13.49
Pork/Other Entrees,Country Fried Sirloin,,14.49
Pork/Other Entrees,Beef Tips,,14.49
Pork/Other Entrees,Country Veg Plate,,10.99
Pork/Other Entrees,Grilled Pork Chops,Single,13.49
Pork/Other Entrees,Grilled Pork Chops,Double,16.49

Seafood Entrees,Grilled Shrimp,,16.99
Seafood Entrees,Grilled Salmon,5 oz,15.99
Seafood Entrees,Grilled Salmon,8 oz,19.99
Seafood Entrees,Fried Catfish,3-piece,14.99
Seafood Entrees,Fried Catfish,4-piece,16.99
Seafood Combos,Fried Catfish & Sirloin,6 oz sirloin,19.49
Seafood Combos,Fried Catfish & Ribs,,17.99

Salads,Grilled Chicken Salad,,13.49
Salads,Grilled Salmon Salad,5 oz,15.99
Salads,Chicken Caesar Salad,,13.49
Salads,Salmon Caesar Salad,5 oz,15.99
Salads,Chicken Critter Salad,,13.49
Salads,Steakhouse Filet Salad,,16.99
Salads,House Salad (side salad),,4.99
Salads,Caesar Salad (side salad),,4.99

Appetizers,Cactus Blossom,,7.99
Appetizers,Combo Appetizer,,12.99
Appetizers,Fried Pickles,,6.99
Appetizers,Twisted Mozzarella,,7.49
Appetizers,Rattlesnake Bites,,7.99
Appetizers,Tater Skins,,7.99
Appetizers,Grilled Shrimp (appetizer),,7.99
Appetizers,Boneless Buffalo Wings,,9.99
Appetizers,Cheese Fries,,8.99
Appetizers,Killer Ribs,,11.99
Appetizers/Soup,Texas Red Chili,Cup,3.99
Appetizers/Soup,Texas Red Chili,Bowl,4.99

Burgers/Handhelds,All-American Cheeseburger,,11.49
Burgers/Handhelds,Bacon Cheeseburger,,12.49
Burgers/Handhelds,Smokehouse Burger,,12.99
Burgers/Handhelds,Pulled Pork (sandwich),,11.49
Burgers/Handhelds,BBQ Chicken (sandwich),,12.49
Burgers/Handhelds,Mushroom Jack Chicken (sandwich),,12.99

Desserts,Grannys Apple Classic,,6.99
Desserts,Strawberry Cheesecake,,6.99
Desserts,Big Ol Brownie,,6.99

Kids/Rangers,Chicken Critters Basket,,8.99
Kids/Rangers,Andys Steak,6 oz sirloin,10.99
Kids/Rangers,Ranger Rib Basket,,10.99
Kids Meals,All-Beef Hot Dog,,4.99
Kids Meals,Macaroni and Cheese,,4.99
Kids Meals,Mini-Cheeseburgers,,6.49
Kids Meals,Jr. Chicken Tenders,,6.99
Kids Meals,Grilled Chicken,,6.99
Kids Meals,Lil Dillo Steak Bites,,7.99

Sides,Baked Potato,,2.99
Sides,Baked Potato,Loaded (upcharge),+1.29
Sides,Buttered Corn,,2.99
Sides,Fresh Vegetables,,2.99
Sides,Green Beans,,2.99
Sides,Mashed Potatoes,,2.99
Sides,Mashed Potatoes,Loaded (upcharge),+1.29
Sides,Seasoned Rice,,2.99
Sides,Steak Fries,,2.99
Sides,Steak Fries,Loaded (upcharge),+1.29
Sides,Sweet Potato,,2.99
Sides,Sweet Potato,Loaded (upcharge),+1.29
Sides,Applesauce,,2.99
Sides,Sauteed Onions,,2.99
Sides,Sauteed Mushrooms,,2.99
""".strip()


def price_to_cents(value: str) -> int:
    if not value:
        return 0
    cleaned = value.strip().replace("$", "")
    cleaned = cleaned.replace("+", "")
    return int(round(float(cleaned) * 100))


def normalize_name(item: str, variant: str) -> str:
    if variant:
        return f"{item} ({variant})"
    return item


def main() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_sqlite_sections_columns()

    session = SessionLocal()
    try:
        rows = [line.strip() for line in RAW_MENU.splitlines() if line.strip()]
        for line in rows[1:]:
            parts = [part.strip() for part in line.split(",", 3)]
            if len(parts) < 4:
                continue
            category_name, item_name, variant, price = parts
            category = session.query(MenuCategory).filter(MenuCategory.name == category_name).first()
            if not category:
                category = MenuCategory(name=category_name)
                session.add(category)
                session.flush()

            display_name = normalize_name(item_name, variant)
            price_cents = price_to_cents(price)

            existing = (
                session.query(MenuItem)
                .filter(MenuItem.name == display_name, MenuItem.category_id == category.id)
                .first()
            )
            if existing:
                existing.price_cents = price_cents
                existing.active = True
            else:
                session.add(MenuItem(name=display_name, category_id=category.id, price_cents=price_cents, active=True))

        session.commit()
        print("Seeded menu categories and items.")
    finally:
        session.close()


if __name__ == "__main__":
    main()
