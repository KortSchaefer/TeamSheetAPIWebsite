import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.database import Base, SessionLocal, engine, ensure_sqlite_sections_columns
from app.models import Section, SectionType


SECTIONS = [
    {"name": "15,22,23", "tables": ["15", "22", "23"], "max_guests": 18,"tags": [""], "cut_order": 21, "sidework": "Tea/Coffee 1", "outwork": "Right Side Hot Well"},
    {"name": "14,13,112", "tables": ["14", "13", "112"], "max_guests": 20,"tags": [], "cut_order": 20, "sidework": "Bread Plates/ Expo", "outwork": "Cold well wipe down, wipe down top of expo and restock all plates. Stock lots of large/small bowls and bread plates"},
    {"name": "11,12,21", "tables": ["11", "12", "21"], "max_guests": 20,"tags": [], "cut_order": 17, "sidework": "Ice Both Stations/ Breadplates", "outwork": "Soda Station 1 & Syrup Pumps, Sweep Bar/Spot Sweep Alley"},
    {"name": "114,123,134", "tables": ["114", "123", "134"], "max_guests": 14,"tags": [], "cut_order": 19, "sidework": "Stock Expo - Ice 1", "outwork": "Cold Well Flips"},
    {"name": "113,133,124", "tables": ["113", "133", "124"], "max_guests": 14,"tags": [], "cut_order": 18, "sidework": "Stock Expo - Ice 2", "outwork": "Tea 1"},
    {"name": "121,122,111", "tables": ["121", "122", "111"], "max_guests": 20,"tags": ["checker"], "cut_order": 22, "sidework": "Sweep Alley, Make lemonade", "outwork": "Font Checker"},
    {"name": "411,412,413", "tables": ["411", "412", "413"], "max_guests": 12,"tags": ["bar"], "cut_order": 16, "sidework": "Bar Back/beer bar mugs (dukes)", "outwork": "Sweep Bar Area"},
    {"name": "131,132,211", "tables": ["131", "132", "211"], "max_guests": 14,"tags": [], "cut_order": 15, "sidework": "Stock Expo - Ice 1", "outwork": "Large trays and wipe down alley walls"},
    {"name": "414,415,212", "tables": ["414", "415", "212"], "max_guests": 20,"tags": ["bar"], "cut_order": 14, "sidework": "Ice Both Stations/ Breadplates", "outwork": "Left side hotwell"},
    {"name": "213,214,234", "tables": ["213", "214", "234"], "max_guests": 16,"tags": [], "cut_order": 13, "sidework": "Breadplates/ Expo", "outwork": "Soda station 2 and breadplates"},
    {"name": "215,216,334", "tables": ["215", "216", "334"], "max_guests": 16,"tags": [], "cut_order": 12, "sidework": "Stock Glasses/ Bread Plates", "outwork": "Stock ALL To-go Supplies, Tea, & Coffee"},
    {"name": "221,222,231", "tables": ["221", "222", "231"], "max_guests": 10,"tags": [], "cut_order": 11, "sidework": "Breadplates/ Expo", "outwork": "Tea 2 and breadplates"},
    {"name": "233,232,223", "tables": ["233", "232", "223"], "max_guests": 10,"tags": [], "cut_order": 10, "sidework": "Tea 2", "outwork": "Stock Expo Pars/Clean Lemon Cutter"},
    {"name": "224,235,236", "tables": ["224", "235", "236"], "max_guests": 10,"tags": [], "cut_order": 9, "sidework": "Stock Expo - Ice 2", "outwork": "Sweep and detail FOH POS"},
    {"name": "237,226,225", "tables": ["237", "226", "225"], "max_guests": 10,"tags": [], "cut_order": 8, "sidework": "Spoons/Brown Sugar/Lemons/Lemonade", "outwork": "Small Trays"},
    {"name": "312,322,332", "tables": ["312", "322", "332"], "max_guests": 14,"tags": [], "cut_order": 7, "sidework": "Countertops/To-go Supplies/Lemonade", "outwork": "Bread plates. All countertops, bottom shelves"},
    {"name": "416,417,418", "tables": ["416", "417", "418"], "max_guests": 14,"tags": ["checker", "bar"], "cut_order": 23, "sidework": "Tea 1 & 2", "outwork": "Back Checker"},
    {"name": "311,321,331", "tables": ["311", "321", "331"], "max_guests": 14,"tags": [], "cut_order": 5, "sidework": "Ice Both Stations/ Expo Stock", "outwork": "Marry condiments T/O and wipe out salad window/stock ALL paper"},
    {"name": "313,323,333", "tables": ["313", "323", "333"], "max_guests": 14,"tags": [], "cut_order": 4, "sidework": "Ice Both Stations/ Expo Stock", "outwork": "Box tops (including nuts) tray jacks detailed, mirror"},
    {"name": "301,302,303", "tables": ["301", "302", "303"], "max_guests": 6,"tags": [], "cut_order": 3, "sidework": "Bread/Plates Expo", "outwork": "Coffee, & Thorough Alley Sweep"},
    {"name": "314,325,335", "tables": ["314", "325", "335"], "max_guests": 14,"tags": [], "cut_order": 2, "sidework": "Tea 2/Bread Plates", "outwork": "Employee drinks, alley hand sink, alley POS"},
    {"name": "315,324,336", "tables": ["315", "324", "336"], "max_guests": 14,"tags": [], "cut_order": 1, "sidework": "Expo Stock - Bread Plates", "outwork": "Clean sugar bin, make 20 bags of sugar, sauce shelves-clean organized"},
]


def main() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_sqlite_sections_columns()
    session = SessionLocal()
    try:
        for section_data in SECTIONS:
            name = section_data["name"]
            existing = session.query(Section).filter(Section.name == name).first()
            if existing:
                for key, value in section_data.items():
                    setattr(existing, key, value)
                existing.label = name
                existing.type = SectionType.FLOOR
                existing.is_active = True
            else:
                session.add(
                    Section(
                        name=name,
                        label=name,
                        type=SectionType.FLOOR,
                        tables=section_data["tables"],
                        tags=section_data["tags"],
                        max_guests=section_data["max_guests"],
                        cut_order=section_data["cut_order"],
                        sidework=section_data["sidework"],
                        outwork=section_data["outwork"],
                        is_active=True,
                    )
                )
        session.commit()
        print(f"Upserted {len(SECTIONS)} sections")
    finally:
        session.close()


if __name__ == "__main__":
    main()
