import asyncio
import os
import tempfile
from pathlib import Path

# Use an isolated temporary directory for data_dir during tests
# to prevent trying to write to container-default /app/data on host/CI environments
_TEST_DATA_DIR = tempfile.TemporaryDirectory()
os.environ.setdefault("GRAVITYLAN_DATA_DIR", _TEST_DATA_DIR.name)

from app.config import settings
settings.data_dir = Path(_TEST_DATA_DIR.name)

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.database import Base, get_db
import app.models as _models  # noqa: F401 - Register all models with Base.metadata

# Use in-memory SQLite for testing
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(
    TEST_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)

TestingSessionLocal = async_sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession,
)

from sqlalchemy import event
@event.listens_for(engine.sync_engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


@pytest_asyncio.fixture
async def db():
    """Provide a clean, isolated database for each test."""
    # For in-memory SQLite, we must create the schema for every test
    # to ensure total isolation when using a StaticPool.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    async with TestingSessionLocal() as session:
        yield session
        # No need to rollback, we drop everything anyway
    
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

@pytest.fixture(autouse=True)
def _reset_login_rate_limit():
    """Failed logins of one test must not lock the next one out (all use the same client IP)."""
    from app.api.auth import reset_login_rate_limit
    reset_login_rate_limit()
    yield
    reset_login_rate_limit()


@pytest_asyncio.fixture
async def client(db):
    """Provide an AsyncClient for testingr the FastAPI app."""
    # Override get_db dependency
    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    
    # We use ASGITransport for testing without a real server
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    
    app.dependency_overrides.clear()

@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for each test case."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest_asyncio.fixture
async def admin_token(db):
    """Create master token and set setup complete in DB for testing."""
    from app.models.setting import Setting
    token = "test-admin-token-12345"
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="api.master_token", value=token))
    await db.commit()
    return token

@pytest_asyncio.fixture
async def db_session(db):
    """Alias for db fixture to support legacy tests."""
    return db

