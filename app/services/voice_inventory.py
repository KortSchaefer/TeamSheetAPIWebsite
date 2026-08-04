import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    InventoryAliasSource,
    InventoryBalance,
    InventoryCount,
    InventoryCountLine,
    InventoryCountStatus,
    InventoryItem,
    InventoryItemAlias,
    InventoryLocation,
    InventoryVoiceEntry,
    InventoryVoiceEntryAction,
    InventoryVoiceReviewStatus,
    InventoryVoiceSession,
    InventoryVoiceSessionCount,
    InventoryVoiceSessionStatus,
    InventoryVoiceUtterance,
    InventoryVoiceUtteranceStatus,
    User,
    UserRole,
)
from app.services.ingredient_catalog import normalize_name
from app.services.count_sheets import populate_count_sheet
from app.services.voice_storage import delete_audio_object


ACTIVE_SESSION_STATUSES = {
    InventoryVoiceSessionStatus.CREATED,
    InventoryVoiceSessionStatus.LISTENING,
    InventoryVoiceSessionStatus.PAUSED,
    InventoryVoiceSessionStatus.OFFLINE,
    InventoryVoiceSessionStatus.NEEDS_REVIEW,
}
ACCEPTED_REVIEW_STATUSES = {
    InventoryVoiceReviewStatus.AUTO_ACCEPTED,
    InventoryVoiceReviewStatus.CORRECTED,
}
NUMBER_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
FRACTION_WORDS = {
    "half": Decimal("0.5"),
    "quarter": Decimal("0.25"),
    "third": Decimal("0.3333"),
}
UNIT_ALIASES = {
    "each": {"ea", "each", "unit", "units", "piece", "pieces"},
    "lb": {"lb", "lbs", "pound", "pounds"},
    "oz": {"oz", "ounce", "ounces"},
    "kg": {"kg", "kgs", "kilogram", "kilograms"},
    "g": {"g", "gram", "grams"},
    "case": {"case", "cases", "cs"},
    "box": {"box", "boxes", "bx"},
    "bag": {"bag", "bags"},
    "head": {"head", "heads"},
    "bottle": {"bottle", "bottles"},
    "can": {"can", "cans"},
    "keg": {"keg", "kegs"},
    "container": {"container", "containers"},
    "package": {"package", "packages", "pack", "packs"},
    "bag_in_box": {"bag in box", "bags in box", "bib"},
    "gallon": {"gallon", "gallons", "gal"},
    "quart": {"quart", "quarts", "qt", "qts"},
    "pint": {"pint", "pints", "pt", "pts"},
}
ACTION_PREFIXES = {
    InventoryVoiceEntryAction.ADD: ("plus ", "add ", "another "),
    InventoryVoiceEntryAction.REPLACE: (
        "actually ",
        "change ",
        "correct ",
        "correction ",
        "make that ",
    ),
    InventoryVoiceEntryAction.REMOVE: (
        "remove ",
        "delete ",
        "scratch ",
        "scratch that ",
    ),
}
TRANSITION_PATTERN = re.compile(
    r"\b(?:next\s+item|next|bump|then)\b",
    flags=re.IGNORECASE,
)


def split_inventory_phrases(transcript: str) -> list[str]:
    """Split transitions only after a complete count or remove phrase."""
    phrases: list[str] = []
    for segment in re.split(r"[;\n]+", transcript):
        cursor = 0
        for transition in TRANSITION_PATTERN.finditer(segment):
            candidate = segment[cursor : transition.start()].strip(" \t,;:-.!?")
            if not candidate:
                continue
            action, actionless = _extract_action(candidate)
            _, quantity, _ = _extract_quantity_and_item(actionless)
            if quantity is None and action != InventoryVoiceEntryAction.REMOVE:
                continue
            phrases.append(candidate)
            cursor = transition.end()
        remainder = segment[cursor:].strip(" \t,;:-.!?")
        if remainder:
            phrases.append(remainder)
    return phrases


def _decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def canonical_unit(value: str | None) -> str | None:
    if not value:
        return None
    clean = normalize_name(value).rstrip(".")
    for canonical, aliases in UNIT_ALIASES.items():
        if clean in aliases:
            return canonical
    return clean.removesuffix("s")


def _number_from_words(value: str) -> Decimal | None:
    words = normalize_name(value).split()
    if not words:
        return None
    if len(words) == 1 and words[0] in FRACTION_WORDS:
        return FRACTION_WORDS[words[0]]
    total = 0
    current = 0
    found = False
    fraction = Decimal("0")
    for word in words:
        if word in NUMBER_WORDS:
            current += NUMBER_WORDS[word]
            found = True
        elif word == "hundred":
            current = max(current, 1) * 100
            found = True
        elif word in FRACTION_WORDS:
            fraction += FRACTION_WORDS[word]
            found = True
        elif word in {"and", "a"}:
            continue
        else:
            return None
    return Decimal(total + current) + fraction if found else None


def parse_spoken_quantity(value: str) -> Decimal | None:
    clean = normalize_name(value)
    fraction_match = re.fullmatch(r"(\d+)\s*/\s*(\d+)", clean)
    if fraction_match and int(fraction_match.group(2)):
        return Decimal(fraction_match.group(1)) / Decimal(fraction_match.group(2))
    try:
        return Decimal(clean)
    except InvalidOperation:
        return _number_from_words(clean)


def convert_to_base(
    item: InventoryItem, quantity: Decimal | None, spoken_unit: str | None
) -> tuple[Decimal | None, str | None]:
    if quantity is None:
        return None, "A quantity is required"
    base = canonical_unit(item.base_unit) or "each"
    unit = canonical_unit(spoken_unit) or base
    if unit == base:
        return quantity, None
    purchase = canonical_unit(item.purchase_unit)
    if purchase and unit == purchase:
        return quantity * Decimal(str(item.purchase_to_base or 1)), None
    weight_factors = {
        "g": Decimal("1"),
        "kg": Decimal("1000"),
        "oz": Decimal("28.349523125"),
        "lb": Decimal("453.59237"),
    }
    if unit in weight_factors and base in weight_factors:
        return (
            quantity * weight_factors[unit] / weight_factors[base],
            None,
        )
    return None, f"No conversion from {spoken_unit or unit} to {item.base_unit}"


def _item_aliases(db: Session, items: list[InventoryItem]) -> dict[int, set[str]]:
    aliases = {item.id: {normalize_name(item.name)} for item in items}
    item_ids = list(aliases)
    if not item_ids:
        return aliases
    for alias in (
        db.query(InventoryItemAlias)
        .filter(
            InventoryItemAlias.inventory_item_id.in_(item_ids),
            InventoryItemAlias.active.is_(True),
        )
        .all()
    ):
        aliases[alias.inventory_item_id].add(alias.normalized_alias)
    for item in items:
        if item.ingredient and item.ingredient.external_id:
            aliases[item.id].add(normalize_name(item.ingredient.external_id.replace("_", " ")))
    return aliases


def candidate_items(
    db: Session, spoken_item: str, *, limit: int = 12
) -> list[dict[str, Any]]:
    clean = normalize_name(spoken_item)
    items = (
        db.query(InventoryItem)
        .filter(InventoryItem.active.is_(True))
        .order_by(InventoryItem.name)
        .all()
    )
    aliases = _item_aliases(db, items)
    scored: list[dict[str, Any]] = []
    clean_tokens = set(clean.split())
    for item in items:
        best = 0.0
        best_alias = normalize_name(item.name)
        for alias in aliases[item.id]:
            ratio = SequenceMatcher(None, clean, alias).ratio()
            if clean == alias:
                ratio = 1.0
            elif clean and (clean in alias or alias in clean):
                ratio = max(ratio, 0.93)
            elif clean_tokens and clean_tokens.issubset(set(alias.split())):
                ratio = max(ratio, 0.89)
            if ratio > best:
                best = ratio
                best_alias = alias
        scored.append(
            {
                "id": item.id,
                "name": item.name,
                "category": item.category,
                "base_unit": item.base_unit,
                "purchase_unit": item.purchase_unit,
                "purchase_to_base": str(item.purchase_to_base),
                "score": round(best, 4),
                "matched_alias": best_alias,
            }
        )
    scored.sort(key=lambda row: (-row["score"], row["name"]))
    return scored[:limit]


def _location_candidates(db: Session, spoken: str) -> list[tuple[InventoryLocation, float]]:
    clean = normalize_name(spoken)
    locations = (
        db.query(InventoryLocation)
        .filter(InventoryLocation.active.is_(True))
        .order_by(InventoryLocation.name)
        .all()
    )
    scored = [
        (
            location,
            1.0
            if normalize_name(location.name) == clean
            else SequenceMatcher(None, clean, normalize_name(location.name)).ratio(),
        )
        for location in locations
    ]
    return sorted(scored, key=lambda row: (-row[1], row[0].name))


def _extract_action(segment: str) -> tuple[InventoryVoiceEntryAction, str]:
    clean = normalize_name(segment)
    for action, prefixes in ACTION_PREFIXES.items():
        for prefix in prefixes:
            if clean.startswith(prefix):
                return action, clean[len(prefix) :].strip()
    return InventoryVoiceEntryAction.SET, clean


def _extract_quantity_and_item(
    segment: str,
) -> tuple[str, Decimal | None, str | None]:
    unit_words = sorted(
        {word for aliases in UNIT_ALIASES.values() for word in aliases},
        key=len,
        reverse=True,
    )
    unit_pattern = "|".join(re.escape(word) for word in unit_words)
    numeric_pattern = (
        r"\d+(?:\.\d+)?|\d+\s*/\s*\d+|"
        r"(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|"
        r"twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|"
        r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|"
        r"quarter|third|and|a)\s*)+"
    )
    matches = list(
        re.finditer(
            rf"\b(?P<number>{numeric_pattern})(?:\s+(?P<unit>{unit_pattern}))?\s*$",
            segment,
            flags=re.IGNORECASE,
        )
    )
    if not matches:
        return segment.strip(), None, None
    match = matches[-1]
    quantity = parse_spoken_quantity(match.group("number"))
    item_phrase = segment[: match.start()].strip(" ,:-")
    return item_phrase, quantity, match.group("unit")


def _deterministic_normalize(
    db: Session, session: InventoryVoiceSession, transcript: str
) -> dict[str, Any]:
    clean = normalize_name(transcript)
    if clean in {"pause", "pause inventory", "stop listening"}:
        return {"command": "PAUSE", "location_id": None, "entries": [], "clarification": None}
    if clean in {"finish", "finish inventory", "done", "inventory complete"}:
        return {"command": "FINISH", "location_id": None, "entries": [], "clarification": None}

    switch_match = re.match(
        r"^(?:switch|move|go|location|now)(?:\s+(?:to|in|at))?\s+(.+)$", clean
    )
    if switch_match:
        locations = _location_candidates(db, switch_match.group(1))
        if locations and locations[0][1] >= 0.78:
            location = locations[0][0]
            return {
                "command": "SWITCH_LOCATION",
                "location_id": location.id,
                "entries": [],
                "clarification": None,
            }
        return {
            "command": "SWITCH_LOCATION",
            "location_id": None,
            "entries": [],
            "clarification": {
                "needed": True,
                "prompt": "Which inventory location did you mean?",
                "options": [
                    {"location_id": location.id, "label": location.name}
                    for location, _ in locations[:3]
                ],
            },
        }

    entries = []
    clarification_options: list[dict[str, Any]] = []
    for raw_segment in split_inventory_phrases(transcript):
        segment = raw_segment.strip()
        if not segment:
            continue
        action, actionless = _extract_action(segment)
        item_phrase, quantity, unit = _extract_quantity_and_item(actionless)
        if action == InventoryVoiceEntryAction.REMOVE and quantity is None:
            quantity = Decimal("0")
        candidates = candidate_items(db, item_phrase)
        chosen = candidates[0] if candidates else None
        unique = bool(
            chosen
            and chosen["score"] >= 0.82
            and (len(candidates) == 1 or chosen["score"] - candidates[1]["score"] >= 0.06)
        )
        item_id = chosen["id"] if unique else None
        ambiguity = None
        if not item_id:
            ambiguity = f"Could not uniquely match '{item_phrase}'"
            clarification_options.extend(
                {"inventory_item_id": row["id"], "label": row["name"]}
                for row in candidates[:3]
            )
        elif quantity is None and action != InventoryVoiceEntryAction.REMOVE:
            ambiguity = "A quantity was not recognized"
        entries.append(
            {
                "inventory_item_id": item_id,
                "spoken_item": item_phrase,
                "quantity": str(quantity) if quantity is not None else None,
                "spoken_unit": unit,
                "operator": action.value,
                "evidence": segment,
                "ambiguity_reason": ambiguity,
            }
        )

    if not entries:
        return {
            "command": "UNKNOWN",
            "location_id": None,
            "entries": [],
            "clarification": {
                "needed": True,
                "prompt": "I did not hear an item and quantity. Please say them again.",
                "options": [],
            },
        }
    needs_clarification = any(row["ambiguity_reason"] for row in entries)
    return {
        "command": "COUNT",
        "location_id": None,
        "entries": entries,
        "clarification": (
            {
                "needed": True,
                "prompt": "I need help matching that inventory entry.",
                "options": clarification_options[:3],
            }
            if needs_clarification
            else None
        ),
    }


NORMALIZATION_SCHEMA = {
    "type": "object",
    "properties": {
        "command": {
            "type": "string",
            "enum": [
                "COUNT",
                "ADD",
                "CORRECT",
                "REMOVE",
                "SWITCH_LOCATION",
                "NOTE",
                "PAUSE",
                "FINISH",
                "UNKNOWN",
            ],
        },
        "location_id": {"type": ["integer", "null"]},
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "inventory_item_id": {"type": ["integer", "null"]},
                    "spoken_item": {"type": "string"},
                    "quantity": {"type": ["number", "null"]},
                    "spoken_unit": {"type": ["string", "null"]},
                    "operator": {
                        "type": "string",
                        "enum": ["SET", "ADD", "REPLACE", "REMOVE", "NOTE"],
                    },
                    "evidence": {"type": "string"},
                    "ambiguity_reason": {"type": ["string", "null"]},
                },
                "required": [
                    "inventory_item_id",
                    "spoken_item",
                    "quantity",
                    "spoken_unit",
                    "operator",
                    "evidence",
                    "ambiguity_reason",
                ],
                "additionalProperties": False,
            },
        },
        "clarification": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "properties": {
                        "needed": {"type": "boolean"},
                        "prompt": {"type": "string"},
                        "options": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "inventory_item_id": {
                                        "type": ["integer", "null"]
                                    },
                                    "location_id": {"type": ["integer", "null"]},
                                    "label": {"type": "string"},
                                },
                                "required": [
                                    "inventory_item_id",
                                    "location_id",
                                    "label",
                                ],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["needed", "prompt", "options"],
                    "additionalProperties": False,
                },
            ]
        },
    },
    "required": ["command", "location_id", "entries", "clarification"],
    "additionalProperties": False,
}


def _openai_normalize(
    db: Session, session: InventoryVoiceSession, transcript: str, manager_id: int
) -> dict[str, Any]:
    from openai import OpenAI

    phrases = split_inventory_phrases(transcript) or [transcript]
    candidate_map: dict[int, dict[str, Any]] = {}
    for phrase in phrases:
        for candidate in candidate_items(db, phrase):
            previous = candidate_map.get(candidate["id"])
            if previous is None or candidate["score"] > previous["score"]:
                candidate_map[candidate["id"]] = candidate
    candidates = sorted(
        candidate_map.values(),
        key=lambda row: (-row["score"], row["name"]),
    )[:40]
    locations = [
        {"id": location.id, "name": location.name}
        for location in db.query(InventoryLocation)
        .filter(InventoryLocation.active.is_(True))
        .order_by(InventoryLocation.name)
        .all()
    ]
    recent = [
        {
            "item_id": row["inventory_item_id"],
            "item": row["item_name"],
            "location_id": row["location_id"],
            "quantity": str(row["quantity"]),
            "unit": row["base_unit"],
        }
        for row in effective_counts(db, session.id)[-10:]
    ]
    context = {
        "transcript": transcript,
        "entry_phrases": phrases,
        "current_location_id": session.current_location_id,
        "candidate_items": candidates,
        "locations": locations,
        "recent_effective_counts": recent,
        "rules": {
            "first_mention": "SET",
            "plus_add_another": "ADD",
            "actually_change_make_that": "REPLACE",
            "unqualified_repeat": "Return SET; the server will require clarification.",
            "entry_boundaries": (
                "Standalone 'next', 'next item', 'bump', and 'then' separate "
                "inventory entries. Punctuation inside an item phrase does not."
            ),
        },
    }
    client = OpenAI(api_key=settings.openai_api_key, timeout=20)
    response = client.responses.create(
        model=settings.openai_normalization_model,
        reasoning={"effort": "none"},
        input=[
            {
                "role": "system",
                "content": (
                    "Normalize restaurant inventory speech. Use only candidate item and "
                    "location IDs. Never invent conversions or values. Preserve the exact "
                    "evidence phrase. Ask for clarification whenever the item, quantity, "
                    "unit, action, or location is ambiguous. Treat each supplied "
                    "entry_phrases value as one separate inventory entry."
                ),
            },
            {"role": "user", "content": json.dumps(context, separators=(",", ":"))},
        ],
        text={
            "format": {
                "type": "json_schema",
                "name": "inventory_voice_command",
                "schema": NORMALIZATION_SCHEMA,
                "strict": True,
            }
        },
        safety_identifier=hashlib.sha256(
            f"inventory-manager:{manager_id}".encode()
        ).hexdigest(),
    )
    return json.loads(response.output_text)


def normalize_utterance(
    db: Session, session: InventoryVoiceSession, transcript: str
) -> dict[str, Any]:
    if settings.openai_api_key:
        try:
            return _openai_normalize(
                db, session, transcript, session.manager_user_id
            )
        except Exception as exc:
            fallback = _deterministic_normalize(db, session, transcript)
            fallback["provider_fallback"] = type(exc).__name__
            return fallback
    result = _deterministic_normalize(db, session, transcript)
    result["provider_fallback"] = "OPENAI_API_KEY_NOT_CONFIGURED"
    return result


def effective_counts(db: Session, session_id: int) -> list[dict[str, Any]]:
    entries = (
        db.query(InventoryVoiceEntry)
        .filter(
            InventoryVoiceEntry.session_id == session_id,
            InventoryVoiceEntry.review_status.in_(ACCEPTED_REVIEW_STATUSES),
        )
        .order_by(InventoryVoiceEntry.id)
        .all()
    )
    state: dict[tuple[int, int], dict[str, Any]] = {}
    for entry in entries:
        if not entry.inventory_item_id or entry.action in {
            InventoryVoiceEntryAction.NOTE,
            InventoryVoiceEntryAction.SWITCH_LOCATION,
        }:
            continue
        key = (entry.location_id, entry.inventory_item_id)
        if entry.action == InventoryVoiceEntryAction.REMOVE:
            state.pop(key, None)
            continue
        quantity = Decimal(str(entry.normalized_quantity or 0))
        if entry.action == InventoryVoiceEntryAction.ADD and key in state:
            state[key]["quantity"] += quantity
            state[key]["source_entry_ids"].append(entry.id)
        else:
            state[key] = {
                "location_id": entry.location_id,
                "location_name": entry.location.name,
                "inventory_item_id": entry.inventory_item_id,
                "item_name": entry.item.name,
                "quantity": quantity,
                "base_unit": entry.item.base_unit,
                "source_entry_ids": [entry.id],
            }
    return sorted(
        state.values(),
        key=lambda row: (row["location_name"].casefold(), row["item_name"].casefold()),
    )


def blocking_review_count(db: Session, session_id: int) -> int:
    return (
        db.query(InventoryVoiceEntry)
        .filter(
            InventoryVoiceEntry.session_id == session_id,
            InventoryVoiceEntry.review_status
            == InventoryVoiceReviewStatus.NEEDS_REVIEW,
        )
        .count()
    )


def serialize_entry(entry: InventoryVoiceEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "utterance_id": entry.utterance_id,
        "location_id": entry.location_id,
        "location_name": entry.location.name,
        "inventory_item_id": entry.inventory_item_id,
        "item_name": entry.item.name if entry.item else None,
        "action": entry.action,
        "spoken_item": entry.spoken_item,
        "spoken_quantity": entry.spoken_quantity,
        "spoken_unit": entry.spoken_unit,
        "normalized_quantity": entry.normalized_quantity,
        "base_unit": entry.item.base_unit if entry.item else None,
        "evidence": entry.evidence,
        "ambiguity_reason": entry.ambiguity_reason,
        "review_status": entry.review_status,
        "supersedes_entry_id": entry.supersedes_entry_id,
        "created_at": entry.created_at,
    }


def _feedback_for_utterance(utterance: InventoryVoiceUtterance) -> dict[str, Any]:
    clarification = (utterance.normalized_payload or {}).get("clarification") or {}
    if utterance.status == InventoryVoiceUtteranceStatus.NEEDS_CLARIFICATION:
        return {
            "tone": "warning",
            "speak": clarification.get("prompt")
            or "That entry needs review. Please check the phone.",
            "clarification_needed": True,
            "options": clarification.get("options", []),
        }
    if utterance.status == InventoryVoiceUtteranceStatus.FAILED:
        return {
            "tone": "error",
            "speak": "I could not save that entry. Please say it again.",
            "clarification_needed": False,
            "options": [],
        }
    command = (utterance.normalized_payload or {}).get("command")
    spoken = None
    if command == "SWITCH_LOCATION" and utterance.session.current_location:
        spoken = f"Now counting {utterance.session.current_location.name}."
    elif command == "PAUSE":
        spoken = "Inventory paused."
    elif command == "FINISH":
        spoken = "Inventory saved for review."
    return {
        "tone": "success",
        "speak": spoken,
        "clarification_needed": False,
        "options": [],
    }


def serialize_utterance(utterance: InventoryVoiceUtterance) -> dict[str, Any]:
    return {
        "id": utterance.id,
        "client_event_id": utterance.client_event_id,
        "sequence": utterance.sequence,
        "transcript": utterance.transcript,
        "status": utterance.status,
        "normalized_payload": utterance.normalized_payload,
        "entries": [serialize_entry(entry) for entry in utterance.entries],
        "feedback": _feedback_for_utterance(utterance),
        "created_at": utterance.created_at,
    }


def serialize_session(db: Session, session: InventoryVoiceSession) -> dict[str, Any]:
    entries = (
        db.query(InventoryVoiceEntry)
        .filter(InventoryVoiceEntry.session_id == session.id)
        .order_by(InventoryVoiceEntry.id)
        .all()
    )
    links = (
        db.query(InventoryVoiceSessionCount)
        .filter(InventoryVoiceSessionCount.session_id == session.id)
        .all()
    )
    return {
        "id": session.id,
        "client_session_id": session.client_session_id,
        "manager_user_id": session.manager_user_id,
        "status": session.status,
        "current_location_id": session.current_location_id,
        "current_location_name": session.current_location.name,
        "started_at": session.started_at,
        "finished_at": session.finished_at,
        "last_client_sequence": session.last_client_sequence,
        "transcription_model": session.transcription_model,
        "normalization_model": session.normalization_model,
        "prompt_version": session.prompt_version,
        "blocking_review_count": blocking_review_count(db, session.id),
        "entries": [serialize_entry(entry) for entry in entries],
        "effective_counts": effective_counts(db, session.id),
        "draft_counts": [
            {
                "location_id": link.location_id,
                "location_name": link.location.name,
                "inventory_count_id": link.inventory_count_id,
                "status": link.inventory_count.status.value,
            }
            for link in sorted(links, key=lambda row: row.location.name.casefold())
        ],
    }


def get_session_for_user(
    db: Session, session_id: int, user: User
) -> InventoryVoiceSession:
    session = (
        db.query(InventoryVoiceSession)
        .filter(InventoryVoiceSession.id == session_id)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Voice inventory session not found")
    if user.role != UserRole.ADMIN and session.manager_user_id != user.id:
        raise HTTPException(status_code=403, detail="This voice session belongs to another manager")
    return session


def create_or_resume_session(
    db: Session,
    user: User,
    client_session_id: str,
    location_id: int,
    device_metadata: dict | None,
) -> InventoryVoiceSession:
    existing = (
        db.query(InventoryVoiceSession)
        .filter(InventoryVoiceSession.client_session_id == client_session_id)
        .first()
    )
    if existing:
        return get_session_for_user(db, existing.id, user)
    location = (
        db.query(InventoryLocation)
        .filter(InventoryLocation.id == location_id, InventoryLocation.active.is_(True))
        .first()
    )
    if not location:
        raise HTTPException(status_code=404, detail="Inventory location not found")
    active = (
        db.query(InventoryVoiceSession)
        .filter(
            InventoryVoiceSession.manager_user_id == user.id,
            InventoryVoiceSession.status.in_(ACTIVE_SESSION_STATUSES),
        )
        .order_by(InventoryVoiceSession.created_at.desc())
        .first()
    )
    if active:
        return active
    retention_deadline = datetime.utcnow() + timedelta(
        hours=settings.voice_audio_retention_hours
    )
    session = InventoryVoiceSession(
        client_session_id=client_session_id,
        manager_user_id=user.id,
        current_location_id=location.id,
        status=InventoryVoiceSessionStatus.CREATED,
        device_metadata=device_metadata,
        transcription_model=settings.openai_transcription_model,
        normalization_model=settings.openai_normalization_model,
        prompt_version=settings.voice_prompt_version,
        audio_delete_after=retention_deadline,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def _has_effective_item(
    db: Session, session_id: int, location_id: int, item_id: int
) -> bool:
    return any(
        row["location_id"] == location_id and row["inventory_item_id"] == item_id
        for row in effective_counts(db, session_id)
    )


def _materialize_payload(
    db: Session,
    session: InventoryVoiceSession,
    utterance: InventoryVoiceUtterance,
    payload: dict[str, Any],
) -> None:
    command = payload.get("command", "UNKNOWN")
    if command == "SWITCH_LOCATION":
        location_id = payload.get("location_id")
        location = (
            db.query(InventoryLocation)
            .filter(
                InventoryLocation.id == location_id,
                InventoryLocation.active.is_(True),
            )
            .first()
        )
        if location:
            session.current_location_id = location.id
            utterance.status = InventoryVoiceUtteranceStatus.ACCEPTED
        else:
            utterance.status = InventoryVoiceUtteranceStatus.NEEDS_CLARIFICATION
        return
    if command == "PAUSE":
        session.status = InventoryVoiceSessionStatus.PAUSED
        utterance.status = InventoryVoiceUtteranceStatus.ACCEPTED
        return
    if command == "FINISH":
        utterance.status = InventoryVoiceUtteranceStatus.ACCEPTED
        return
    if command == "UNKNOWN" or not payload.get("entries"):
        utterance.status = InventoryVoiceUtteranceStatus.NEEDS_CLARIFICATION
        return

    any_review = False
    clarification = payload.get("clarification") or {}
    for normalized in payload.get("entries", []):
        candidate_phrase = (
            normalized.get("spoken_item")
            or normalized.get("evidence")
            or utterance.transcript
        )
        candidate_ids = {
            row["id"] for row in candidate_items(db, candidate_phrase, limit=20)
        }
        item_id = normalized.get("inventory_item_id")
        item = (
            db.query(InventoryItem)
            .filter(InventoryItem.id == item_id, InventoryItem.active.is_(True))
            .first()
            if item_id in candidate_ids
            else None
        )
        try:
            action = InventoryVoiceEntryAction(
                normalized.get("operator", "SET")
            )
        except ValueError:
            action = InventoryVoiceEntryAction.SET
        spoken_quantity = _decimal(normalized.get("quantity"))
        spoken_unit = normalized.get("spoken_unit")
        ambiguity = normalized.get("ambiguity_reason")
        normalized_quantity = None
        if item and action != InventoryVoiceEntryAction.NOTE:
            normalized_quantity, conversion_error = convert_to_base(
                item, spoken_quantity, spoken_unit
            )
            ambiguity = ambiguity or conversion_error
        if action == InventoryVoiceEntryAction.REMOVE:
            normalized_quantity = Decimal("0")
            ambiguity = None if item else ambiguity or "Inventory item is unresolved"
        if not item:
            ambiguity = ambiguity or "Inventory item is unresolved"
        if (
            item
            and action == InventoryVoiceEntryAction.SET
            and _has_effective_item(
                db, session.id, session.current_location_id, item.id
            )
        ):
            ambiguity = (
                "This item was already counted. Say add or change to choose the action."
            )
        if clarification.get("needed"):
            ambiguity = ambiguity or clarification.get("prompt")
        review_status = (
            InventoryVoiceReviewStatus.NEEDS_REVIEW
            if ambiguity
            else InventoryVoiceReviewStatus.AUTO_ACCEPTED
        )
        any_review = any_review or review_status == InventoryVoiceReviewStatus.NEEDS_REVIEW
        db.add(
            InventoryVoiceEntry(
                session_id=session.id,
                utterance_id=utterance.id,
                location_id=session.current_location_id,
                inventory_item_id=item.id if item else None,
                action=action,
                spoken_item=normalized.get("spoken_item"),
                spoken_quantity=spoken_quantity,
                spoken_unit=spoken_unit,
                normalized_quantity=normalized_quantity,
                evidence=normalized.get("evidence") or utterance.transcript,
                ambiguity_reason=ambiguity,
                review_status=review_status,
            )
        )
    utterance.status = (
        InventoryVoiceUtteranceStatus.NEEDS_CLARIFICATION
        if any_review
        else InventoryVoiceUtteranceStatus.ACCEPTED
    )


def ingest_utterance(
    db: Session,
    session: InventoryVoiceSession,
    *,
    client_event_id: str,
    sequence: int,
    transcript: str,
    realtime_item_id: str | None = None,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
    audio_object_key: str | None = None,
) -> InventoryVoiceUtterance:
    duplicate = (
        db.query(InventoryVoiceUtterance)
        .filter(
            InventoryVoiceUtterance.session_id == session.id,
            InventoryVoiceUtterance.client_event_id == client_event_id,
        )
        .first()
    )
    if duplicate:
        return duplicate
    sequence_duplicate = (
        db.query(InventoryVoiceUtterance)
        .filter(
            InventoryVoiceUtterance.session_id == session.id,
            InventoryVoiceUtterance.sequence == sequence,
        )
        .first()
    )
    if sequence_duplicate:
        raise HTTPException(
            status_code=409,
            detail="That sequence number is already assigned to another event",
        )
    if session.status in {
        InventoryVoiceSessionStatus.FINISHED,
        InventoryVoiceSessionStatus.ABANDONED,
    }:
        raise HTTPException(status_code=409, detail="This voice session is closed")
    utterance = InventoryVoiceUtterance(
        session_id=session.id,
        client_event_id=client_event_id,
        sequence=sequence,
        realtime_item_id=realtime_item_id,
        started_at=started_at,
        ended_at=ended_at,
        transcript=transcript.strip(),
        audio_object_key=audio_object_key,
        status=InventoryVoiceUtteranceStatus.RECEIVED,
    )
    db.add(utterance)
    db.flush()
    payload = normalize_utterance(db, session, utterance.transcript)
    utterance.normalized_payload = payload
    utterance.status = InventoryVoiceUtteranceStatus.NORMALIZED
    _materialize_payload(db, session, utterance, payload)
    session.last_client_sequence = max(session.last_client_sequence, sequence)
    if session.status in {
        InventoryVoiceSessionStatus.CREATED,
        InventoryVoiceSessionStatus.OFFLINE,
    }:
        session.status = InventoryVoiceSessionStatus.LISTENING
    db.commit()
    db.refresh(utterance)
    if utterance.entries and payload.get("command") not in {
        "PAUSE",
        "FINISH",
        "SWITCH_LOCATION",
    }:
        sync_draft_counts(db, session)
        db.refresh(utterance)
    if payload.get("command") == "FINISH":
        finish_session(db, session)
        db.refresh(utterance)
    return utterance


def ensure_drafts_editable(session: InventoryVoiceSession) -> None:
    for link in session.count_links:
        if link.inventory_count.status != InventoryCountStatus.DRAFT:
            raise HTTPException(
                status_code=409,
                detail="Voice entries cannot change after a linked count is submitted",
            )


def correct_entry(
    db: Session,
    session: InventoryVoiceSession,
    original: InventoryVoiceEntry,
    *,
    inventory_item_id: int | None,
    location_id: int | None,
    quantity: Decimal | None,
    unit: str | None,
    review_status: InventoryVoiceReviewStatus | None,
) -> InventoryVoiceEntry:
    ensure_drafts_editable(session)
    if original.session_id != session.id:
        raise HTTPException(status_code=404, detail="Voice inventory entry not found")
    if review_status == InventoryVoiceReviewStatus.REJECTED:
        original.review_status = InventoryVoiceReviewStatus.REJECTED
        original.ambiguity_reason = None
        db.commit()
        if session.finished_at:
            sync_draft_counts(db, session)
            session.status = (
                InventoryVoiceSessionStatus.NEEDS_REVIEW
                if blocking_review_count(db, session.id)
                else InventoryVoiceSessionStatus.FINISHED
            )
            db.commit()
        return original
    chosen_item_id = inventory_item_id or original.inventory_item_id
    chosen_location_id = location_id or original.location_id
    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.id == chosen_item_id, InventoryItem.active.is_(True))
        .first()
    )
    location = (
        db.query(InventoryLocation)
        .filter(
            InventoryLocation.id == chosen_location_id,
            InventoryLocation.active.is_(True),
        )
        .first()
    )
    if not item or not location:
        raise HTTPException(status_code=404, detail="Inventory item or location not found")
    chosen_quantity = quantity if quantity is not None else original.spoken_quantity
    chosen_unit = unit if unit is not None else original.spoken_unit
    normalized_quantity, conversion_error = convert_to_base(
        item, chosen_quantity, chosen_unit
    )
    if conversion_error:
        raise HTTPException(status_code=400, detail=conversion_error)
    original.review_status = InventoryVoiceReviewStatus.REJECTED
    replacement = InventoryVoiceEntry(
        session_id=session.id,
        utterance_id=original.utterance_id,
        location_id=location.id,
        inventory_item_id=item.id,
        action=(
            InventoryVoiceEntryAction.REPLACE
            if _has_effective_item(db, session.id, location.id, item.id)
            else InventoryVoiceEntryAction.SET
        ),
        spoken_item=original.spoken_item,
        spoken_quantity=chosen_quantity,
        spoken_unit=chosen_unit,
        normalized_quantity=normalized_quantity,
        evidence=original.evidence,
        ambiguity_reason=None,
        review_status=InventoryVoiceReviewStatus.CORRECTED,
        supersedes_entry_id=original.id,
    )
    db.add(replacement)
    db.flush()
    if not any(
        row.review_status == InventoryVoiceReviewStatus.NEEDS_REVIEW
        for row in original.utterance.entries
        if row.id != original.id
    ):
        original.utterance.status = InventoryVoiceUtteranceStatus.ACCEPTED
    db.commit()
    if session.finished_at:
        sync_draft_counts(db, session)
        session.status = (
            InventoryVoiceSessionStatus.NEEDS_REVIEW
            if blocking_review_count(db, session.id)
            else InventoryVoiceSessionStatus.FINISHED
        )
        db.commit()
    return replacement


def sync_draft_counts(db: Session, session: InventoryVoiceSession) -> None:
    ensure_drafts_editable(session)
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in effective_counts(db, session.id):
        grouped[row["location_id"]].append(row)
    links = {link.location_id: link for link in session.count_links}
    for location_id, rows in grouped.items():
        link = links.get(location_id)
        if link is None:
            requested_count_id = (session.device_metadata or {}).get(
                "target_count_id"
            )
            count = None
            if requested_count_id:
                already_linked = (
                    db.query(InventoryVoiceSessionCount)
                    .filter(
                        InventoryVoiceSessionCount.inventory_count_id
                        == requested_count_id
                    )
                    .first()
                )
                if not already_linked:
                    count = (
                        db.query(InventoryCount)
                        .filter(
                            InventoryCount.id == requested_count_id,
                            InventoryCount.location_id == location_id,
                            InventoryCount.status == InventoryCountStatus.DRAFT,
                            InventoryCount.counted_by_user_id
                            == session.manager_user_id,
                        )
                        .first()
                    )
            if count is None:
                count = InventoryCount(
                    location_id=location_id,
                    counted_by_user_id=session.manager_user_id,
                    notes=f"Voice inventory session #{session.id}",
                )
                db.add(count)
                db.flush()
            link = InventoryVoiceSessionCount(
                session_id=session.id,
                location_id=location_id,
                inventory_count_id=count.id,
                inventory_count=count,
            )
            db.add(link)
            session.count_links.append(link)
        count = link.inventory_count
        populate_count_sheet(db, count)
        existing_lines = {
            line.inventory_item_id: line for line in count.lines
        }
        active_item_ids = {row["inventory_item_id"] for row in rows}
        for line in count.lines:
            if (
                line.source == "VOICE"
                and line.inventory_item_id not in active_item_ids
            ):
                line.counted_quantity = Decimal("0")
                line.is_counted = False
                line.source = None
                line.confidence = None
                line.review_status = "PENDING"
                line.evidence = None
                line.revision = (line.revision or 0) + 1
        for row in rows:
            balance = (
                db.query(InventoryBalance)
                .filter(
                    InventoryBalance.inventory_item_id == row["inventory_item_id"],
                    InventoryBalance.location_id == location_id,
                )
                .first()
            )
            line = existing_lines.get(row["inventory_item_id"])
            if line is None:
                line = InventoryCountLine(
                    inventory_item_id=row["inventory_item_id"],
                    expected_quantity=balance.quantity_on_hand if balance else Decimal("0"),
                    display_order=len(count.lines),
                    revision=0,
                )
                count.lines.append(line)
            line.counted_quantity = row["quantity"]
            line.is_counted = True
            line.source = "VOICE"
            line.confidence = 1.0
            line.review_status = "READY"
            line.evidence = (
                "Voice inventory; source entries "
                + ",".join(str(entry_id) for entry_id in row["source_entry_ids"])
            )
            line.notes = line.evidence
            line.updated_by_user_id = session.manager_user_id
            line.revision = (line.revision or 0) + 1
        count.revision = (count.revision or 0) + 1
    for location_id, link in links.items():
        if location_id not in grouped:
            for line in link.inventory_count.lines:
                if line.source == "VOICE":
                    line.counted_quantity = Decimal("0")
                    line.is_counted = False
                    line.source = None
                    line.confidence = None
                    line.review_status = "PENDING"
                    line.evidence = None
                    line.revision = (line.revision or 0) + 1
            link.inventory_count.revision = (
                link.inventory_count.revision or 0
            ) + 1
    db.commit()


def finish_session(db: Session, session: InventoryVoiceSession) -> None:
    if session.status == InventoryVoiceSessionStatus.ABANDONED:
        raise HTTPException(status_code=409, detail="Abandoned sessions cannot be finished")
    session.finished_at = session.finished_at or datetime.utcnow()
    session.status = (
        InventoryVoiceSessionStatus.NEEDS_REVIEW
        if blocking_review_count(db, session.id)
        else InventoryVoiceSessionStatus.FINISHED
    )
    sync_draft_counts(db, session)


def cleanup_expired_audio(db: Session) -> int:
    now = datetime.utcnow()
    sessions = (
        db.query(InventoryVoiceSession)
        .filter(
            InventoryVoiceSession.audio_delete_after.is_not(None),
            InventoryVoiceSession.audio_delete_after <= now,
        )
        .all()
    )
    removed = 0
    for session in sessions:
        for utterance in session.utterances:
            if utterance.audio_object_key:
                try:
                    delete_audio_object(utterance.audio_object_key)
                finally:
                    utterance.audio_object_key = None
                    removed += 1
        session.audio_delete_after = None
    if sessions:
        db.commit()
    return removed
