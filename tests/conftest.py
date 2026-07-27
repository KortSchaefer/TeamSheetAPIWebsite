import asyncio
import pytest
import pytest_asyncio
import httpx
from httpx import AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import create_app


SQLALCHEMY_TEST_DATABASE_URL = "sqlite+pysqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def app():
    app = create_app()
    return app


@pytest.fixture(scope="session")
def test_engine():
    engine = create_engine(
        SQLALCHEMY_TEST_DATABASE_URL,
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="session")
def TestingSessionLocal(test_engine):
    return sessionmaker(bind=test_engine, autoflush=False, autocommit=False, future=True)


@pytest.fixture(autouse=True)
def override_get_db(app, TestingSessionLocal):
    def _get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    yield
    app.dependency_overrides.pop(get_db, None)


@pytest_asyncio.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
