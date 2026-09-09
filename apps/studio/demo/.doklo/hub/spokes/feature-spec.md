---
type: feature-spec
title: 기능 명세
related_doks: [AUTH-SOCIAL, CART, PAY, PAY-INSTALL, ORD]
version: 2
auto_generated: true
last_updated: 2026-05-08
---

# 기능 명세서

Doks Hub에 등록된 비즈니스 기능 5개의 명세를 한 곳에서 정리한 문서입니다. 코드 변경 시 자동으로 갱신됩니다.

## AUTH-SOCIAL 소셜 로그인

**상태**: active · **서비스**: web, api

OAuth 공급자(Google, Apple, Kakao)를 통한 통합 로그인.

**규칙**

- `BR-AUTH-SOCIAL-01` 동일 이메일이 다른 공급자로 가입된 경우 자동 계정 통합

**인수 조건**

- `AC-AUTH-SOCIAL-01` OAuth 콜백 응답을 5초 이내에 검증한다

## CART 장바구니

**상태**: active · **서비스**: web, api

상품 보관 + 수량 조정. 비로그인 사용자는 브라우저 세션 단위로 유지됩니다.

**규칙**

- `BR-CART-01` 단일 상품 수량은 99개를 초과할 수 없다

**인수 조건**

- `AC-CART-01` 장바구니가 30일간 유지된다 (로그인 사용자)

## PAY 결제 처리 (draft)

**상태**: draft (검토 대기) · **서비스**: web, api

카드, 계좌이체, 간편결제 중 선택. PG 응답으로 성공/실패 결정.

**규칙**

- `BR-PAY-01` 결제 금액은 최소 1,000원 이상이어야 한다
- `BR-PAY-02` 동일 카드로 1분 내 5회 이상 결제 시도 시 거래를 잠시 차단한다
- `BR-PAY-03` VAT는 결제 금액의 10%를 포함한다

## PAY-INSTALL 분할 결제 (planned)

고액 주문에 대해 2~12개월 분할 옵션. 구현 미정.

## ORD 주문 내역 (review)

**상태**: review · **서비스**: web, admin

시간순 주문 조회 + 상세 + 영수증.

**규칙**

- `BR-ORD-01` 3개월 이전 주문은 별도 전체 보기 클릭 시 노출
