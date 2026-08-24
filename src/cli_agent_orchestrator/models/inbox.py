"""Inbox message models."""

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class OrchestrationType(str, Enum):
    """Orchestration mode for a message delivery."""

    SEND_MESSAGE = "send_message"
    HANDOFF = "handoff"
    ASSIGN = "assign"


class MessageStatus(str, Enum):
    """Message status enumeration."""

    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"


class InboxMessage(BaseModel):
    """Inbox message model."""

    id: int = Field(..., description="Message ID")
    sender_id: str = Field(..., description="Sender terminal ID")
    receiver_id: str = Field(..., description="Receiver terminal ID")
    message: str = Field(..., description="Message content")
    status: MessageStatus = Field(..., description="Message status")
    created_at: datetime = Field(..., description="Creation timestamp")
    orchestration_type: Optional[OrchestrationType] = Field(
        default=None,
        description="Observed delivery mode for this inbox row",
    )
    task_id: Optional[str] = Field(
        default=None,
        description="Stable direct-task identifier shared by dispatch, return, and review messages",
    )
    reply_to_message_id: Optional[int] = Field(
        default=None,
        description="Inbox message this row replies to, when observed",
    )
    delivered_at: Optional[datetime] = Field(
        default=None,
        description="Timestamp when CAO successfully submitted the message to the receiver terminal",
    )
    started_at: Optional[datetime] = Field(
        default=None,
        description="Timestamp when the submitted direct task became executable in the terminal",
    )
    reviewed_at: Optional[datetime] = Field(
        default=None,
        description="Timestamp of an explicit ACCEPT or REJECT review",
    )
    review_verdict: Optional[str] = Field(
        default=None,
        description="Explicit direct-task review verdict (ACCEPT or REJECT)",
    )
