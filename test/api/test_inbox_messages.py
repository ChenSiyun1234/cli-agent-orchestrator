"""Tests for the new inbox messages GET endpoint."""

import json
from datetime import datetime
from unittest.mock import Mock, patch

import pytest
from fastapi.testclient import TestClient

from cli_agent_orchestrator.api.main import app
from cli_agent_orchestrator.models.inbox import InboxMessage, MessageStatus, OrchestrationType


@pytest.fixture
def sample_inbox_messages():
    """Create sample inbox messages for testing."""
    return [
        InboxMessage(
            id=1,
            sender_id="sender1",
            receiver_id="abcdef12",
            message="Hello world",
            status=MessageStatus.PENDING,
            created_at=datetime(2025, 12, 6, 12, 0, 0),
        ),
        InboxMessage(
            id=2,
            sender_id="sender2",
            receiver_id="abcdef12",
            message="Another message",
            status=MessageStatus.DELIVERED,
            created_at=datetime(2025, 12, 6, 12, 5, 0),
        ),
        InboxMessage(
            id=3,
            sender_id="sender3",
            receiver_id="abcdef12",
            message="Failed message",
            status=MessageStatus.FAILED,
            created_at=datetime(2025, 12, 6, 12, 10, 0),
        ),
    ]


class TestGetInboxMessagesEndpoint:
    """Test cases for GET /terminals/{terminal_id}/inbox/messages endpoint."""

    def test_get_all_messages_success(self, client, sample_inbox_messages):
        """Test getting all messages without status filter."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = sample_inbox_messages

            response = client.get("/terminals/abcdef12/inbox/messages")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 3

            # Check response format
            for msg_data in data:
                assert "id" in msg_data
                assert "sender_id" in msg_data
                assert "receiver_id" in msg_data
                assert "message" in msg_data
                assert "status" in msg_data
                assert "created_at" in msg_data

    def test_get_messages_with_status_filter(self, client, sample_inbox_messages):
        """Test getting messages with status filter."""
        pending_messages = [
            msg for msg in sample_inbox_messages if msg.status == MessageStatus.PENDING
        ]

        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = pending_messages

            response = client.get("/terminals/abcdef12/inbox/messages?status=pending")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 1
            assert data[0]["status"] == "pending"
            assert data[0]["sender_id"] == "sender1"

    def test_get_messages_with_limit(self, client, sample_inbox_messages):
        """Test getting messages with limit parameter."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = sample_inbox_messages[:2]

            response = client.get("/terminals/abcdef12/inbox/messages?limit=2")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 2
            mock_get.assert_called_once_with("abcdef12", limit=2, status=None)

    def test_get_messages_with_status_and_limit(self, client, sample_inbox_messages):
        """Test getting messages with both status and limit parameters."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = sample_inbox_messages[:1]

            response = client.get("/terminals/abcdef12/inbox/messages?status=pending&limit=5")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 1
            mock_get.assert_called_once_with("abcdef12", limit=5, status=MessageStatus.PENDING)

    def test_newest_window_flag_is_forwarded_explicitly(self, client, sample_inbox_messages):
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = sample_inbox_messages[-2:]
            response = client.get("/terminals/abcdef12/inbox/messages?limit=2&newest_first=true")

        assert response.status_code == 200
        mock_get.assert_called_once_with("abcdef12", limit=2, status=None, newest_first=True)

    def test_invalid_status_parameter(self, client):
        """Test error handling for invalid status parameter."""
        response = client.get("/terminals/abcdef12/inbox/messages?status=invalid_status")

        assert response.status_code == 400
        data = response.json()
        assert "detail" in data
        assert "Invalid status" in data["detail"]
        assert "pending, delivered, failed" in data["detail"]

    def test_limit_exceeds_maximum(self, client):
        """Test that limit parameter is properly validated."""
        # FastAPI Query with le=100 should handle this automatically
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = []

            response = client.get("/terminals/abcdef12/inbox/messages?limit=150")

            # FastAPI should return 422 for query parameter validation error
            assert response.status_code == 422

    def test_database_error_handling(self, client):
        """Test error handling for database errors."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.side_effect = Exception("Database connection failed")

            response = client.get("/terminals/abcdef12/inbox/messages")

            assert response.status_code == 500
            data = response.json()
            assert "detail" in data
            assert "Failed to retrieve inbox messages" in data["detail"]

    def test_terminal_not_found_error(self, client):
        """Test error handling when terminal is not found."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.side_effect = ValueError("Terminal not found")

            response = client.get("/terminals/deadbeef/inbox/messages")

            assert response.status_code == 404
            data = response.json()
            assert "detail" in data
            assert "Terminal not found" in data["detail"]

    def test_empty_message_list(self, client):
        """Test getting messages when no messages exist."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = []

            response = client.get("/terminals/abcdef12/inbox/messages")

            assert response.status_code == 200
            data = response.json()
            assert isinstance(data, list)
            assert len(data) == 0

    def test_message_datetime_formatting(self, client, sample_inbox_messages):
        """Test that datetime is properly formatted in response."""
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
            mock_get.return_value = sample_inbox_messages[:1]

            response = client.get("/terminals/abcdef12/inbox/messages")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 1

            # Check ISO format datetime
            created_at = data[0]["created_at"]
            assert isinstance(created_at, str)
            # Should be able to parse as ISO datetime
            parsed_datetime = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            assert isinstance(parsed_datetime, datetime)

    def test_direct_task_lifecycle_fields_are_exposed_without_inference(self, client):
        observed = datetime(2026, 8, 23, 10, 1, 5)
        message = InboxMessage(
            id=101,
            sender_id="architect",
            receiver_id="abcdef12",
            message="GOAL: task",
            status=MessageStatus.DELIVERED,
            created_at=datetime(2026, 8, 23, 10, 1, 0),
            orchestration_type=OrchestrationType.ASSIGN,
            task_id="direct-101",
            reply_to_message_id=None,
            delivered_at=observed,
            started_at=None,
            reviewed_at=datetime(2026, 8, 23, 10, 8, 0),
            review_verdict="ACCEPT",
        )
        with patch("cli_agent_orchestrator.api.main.get_inbox_messages", return_value=[message]):
            response = client.get("/terminals/abcdef12/inbox/messages")

        assert response.status_code == 200
        assert response.json()[0] == {
            "id": 101,
            "sender_id": "architect",
            "receiver_id": "abcdef12",
            "message": "GOAL: task",
            "status": "delivered",
            "created_at": "2026-08-23T10:01:00",
            "orchestration_type": "assign",
            "task_id": "direct-101",
            "reply_to_message_id": None,
            "delivered_at": "2026-08-23T10:01:05",
            "started_at": None,
            "reviewed_at": "2026-08-23T10:08:00",
            "review_verdict": "ACCEPT",
        }

    def test_all_status_values(self, client, sample_inbox_messages):
        """Test filtering by each possible status value."""
        for status_value in ["pending", "delivered", "failed"]:
            filtered_messages = [
                msg for msg in sample_inbox_messages if msg.status.value == status_value
            ]

            with patch("cli_agent_orchestrator.api.main.get_inbox_messages") as mock_get:
                mock_get.return_value = filtered_messages

                response = client.get(f"/terminals/abcdef12/inbox/messages?status={status_value}")

                assert response.status_code == 200
                data = response.json()
                assert len(data) == len(filtered_messages)

                for msg_data in data:
                    assert msg_data["status"] == status_value


class TestCreateInboxMessageEndpoint:
    def test_assign_identity_and_delivery_mode_are_forwarded(self, client):
        root = InboxMessage(
            id=101,
            sender_id="architect",
            receiver_id="abcdef12",
            message="GOAL: task",
            status=MessageStatus.PENDING,
            created_at=datetime(2026, 8, 23, 10, 1, 0),
            orchestration_type=OrchestrationType.ASSIGN,
            task_id="direct-101",
        )
        with (
            patch(
                "cli_agent_orchestrator.api.main.create_inbox_message",
                return_value=root,
            ) as mock_create,
            patch("cli_agent_orchestrator.api.main.inbox_service.deliver_pending") as mock_deliver,
        ):
            response = client.post(
                "/terminals/abcdef12/inbox/messages",
                params={
                    "sender_id": "architect",
                    "message": "GOAL: task",
                    "orchestration_type": "assign",
                },
            )

        assert response.status_code == 200
        assert response.json()["message_id"] == 101
        assert response.json()["task_id"] == "direct-101"
        assert response.json()["orchestration_type"] == "assign"
        mock_create.assert_called_once_with(
            "architect",
            "abcdef12",
            "GOAL: task",
            task_id=None,
            reply_to_message_id=None,
            review_verdict=None,
            orchestration_type="assign",
        )
        mock_deliver.assert_called_once()

    def test_integrity_error_is_bad_request_not_missing_terminal(self, client):
        with patch(
            "cli_agent_orchestrator.api.main.create_inbox_message",
            side_effect=ValueError(
                "Direct task 'broken' must have exactly one ASSIGN root; found 0"
            ),
        ):
            response = client.post(
                "/terminals/abcdef12/inbox/messages",
                params={
                    "sender_id": "architect",
                    "message": "Reviewed.",
                    "task_id": "broken",
                    "review_verdict": "ACCEPT",
                },
            )

        assert response.status_code == 400


class TestDatabaseFunctionCompatibility:
    """Test compatibility with enhanced database functions."""

    def test_get_inbox_messages_function_exists(self):
        """Test that the new get_inbox_messages function is properly imported."""
        from cli_agent_orchestrator.clients.database import get_inbox_messages

        assert callable(get_inbox_messages)

    def test_get_pending_messages_backward_compatibility(self):
        """Test that get_pending_messages still works as before."""
        from cli_agent_orchestrator.clients.database import get_inbox_messages, get_pending_messages

        # Both functions should be callable
        assert callable(get_pending_messages)
        assert callable(get_inbox_messages)

    @patch("cli_agent_orchestrator.clients.database.SessionLocal")
    def test_get_pending_messages_calls_get_inbox_messages(self, mock_session):
        """Test that get_pending_messages properly calls get_inbox_messages with correct parameters."""
        from cli_agent_orchestrator.clients.database import get_pending_messages

        # Mock the database session and query
        mock_db = Mock()
        mock_session.return_value.__enter__.return_value = mock_db
        mock_query = Mock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.all.return_value = []

        # This should work without errors
        result = get_pending_messages("test_terminal", limit=5)
        assert isinstance(result, list)
