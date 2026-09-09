---
type: api-reference
title: API 레퍼런스
related_doks: [AUTH-SOCIAL, CART, PAY]
version: 1
auto_generated: true
last_updated: 2026-05-08
---

# API Reference

코드에서 자동 추출된 백엔드 엔드포인트.

## Authentication

### POST /api/auth/social

OAuth 콜백을 받아 세션을 발급합니다.

**Request body**

```json
{
  "provider": "google",
  "code": "..."
}
```

**Response**

```json
{
  "session_token": "...",
  "user_id": "..."
}
```

관련 Dok: `AUTH-SOCIAL`

## Cart

### GET /api/cart

현재 장바구니 항목을 조회합니다.

### POST /api/cart/items

상품을 장바구니에 추가합니다.

**Request body**

- `product_id` (string, required)
- `quantity` (number, default 1, max 99)

관련 Dok: `CART`

## Payment

### POST /api/payment

결제 게이트웨이로 결제 승인 요청을 보냅니다.

**Request body**

- `amount` (number, required, min 1000)
- `method` (string — card | bank_transfer | quick_pay)
- `payment_info` (object, 결제 수단별 정보)

응답 직후 `payment_info`는 폐기됩니다.

관련 Dok: `PAY`
