"""Simple helper to fetch a random joke from the official joke API."""

from typing import Any, Dict

import requests

API_URL = "https://official-joke-api.appspot.com/jokes/random"


def fetch_random_joke() -> Dict[str, Any]:
    """Call the public API and extract the setup/punchline fields."""
    try:
        response = requests.get(API_URL, timeout=5)
        response.raise_for_status()
        joke_data = response.json()
        return {
            "setup": joke_data.get("setup", "No setup found."),
            "punchline": joke_data.get("punchline", "No punchline found."),
        }
    except requests.RequestException as exc:
        return {"error": str(exc)}


if __name__ == "__main__":
    joke = fetch_random_joke()
    print(joke)
