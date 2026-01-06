from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Ingredient, RecipeItem, StockMovement, User

router = APIRouter(prefix="/inventory", tags=["inventory"])


@router.get("/ingredients", response_model=list[schemas.IngredientRead])
def list_ingredients(
    active: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Ingredient)
    if active is not None:
        query = query.filter(Ingredient.active == active)
    return query.order_by(Ingredient.name).all()


@router.post("/ingredients", response_model=schemas.IngredientRead, status_code=status.HTTP_201_CREATED)
def create_ingredient(
    payload: schemas.IngredientCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    ingredient = Ingredient(**payload.dict())
    db.add(ingredient)
    db.commit()
    db.refresh(ingredient)
    return ingredient


@router.post("/recipes", response_model=schemas.RecipeItemRead, status_code=status.HTTP_201_CREATED)
def create_recipe_item(
    payload: schemas.RecipeItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    recipe = RecipeItem(**payload.dict())
    db.add(recipe)
    db.commit()
    db.refresh(recipe)
    return recipe


@router.post("/receive", response_model=schemas.StockMovementRead, status_code=status.HTTP_201_CREATED)
def receive_stock(
    payload: schemas.StockMovementCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    ingredient = db.query(Ingredient).filter(Ingredient.id == payload.ingredient_id).first()
    if not ingredient:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    movement = StockMovement(
        ingredient_id=payload.ingredient_id,
        quantity_change=payload.quantity_change,
        reason=payload.reason or "RECEIVE",
        notes=payload.notes,
    )
    db.add(movement)
    db.commit()
    db.refresh(movement)
    return movement


@router.post("/adjust", response_model=schemas.StockMovementRead, status_code=status.HTTP_201_CREATED)
def adjust_stock(
    payload: schemas.StockMovementCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    ingredient = db.query(Ingredient).filter(Ingredient.id == payload.ingredient_id).first()
    if not ingredient:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    movement = StockMovement(
        ingredient_id=payload.ingredient_id,
        quantity_change=payload.quantity_change,
        reason=payload.reason or "ADJUST",
        notes=payload.notes,
    )
    db.add(movement)
    db.commit()
    db.refresh(movement)
    return movement


@router.get("/stock-levels", response_model=list[schemas.StockLevelRead])
def stock_levels(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ingredients = db.query(Ingredient).all()
    results = []
    for ingredient in ingredients:
        total = sum(m.quantity_change for m in ingredient.stock_movements)
        results.append(
            schemas.StockLevelRead(
                ingredient_id=ingredient.id,
                name=ingredient.name,
                unit=ingredient.unit,
                quantity_on_hand=total,
            )
        )
    return results
