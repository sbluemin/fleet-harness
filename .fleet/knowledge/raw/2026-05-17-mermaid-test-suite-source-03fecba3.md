---
id: "mermaid-test-suite-source"
created: "2026-05-17T06:10:31.919Z"
sourceType: "inline"
title: "Mermaid Rendering Test Suite"
tags: ["test", "mermaid"]
contentHash: "03fecba3"
---
# Mermaid Rendering Test Suite

이 문서는 새로 구현된 Mermaid 다이어그램의 가로/세로 스크롤 및 클릭 시 확대(Modal) 기능을 테스트하기 위해 작성되었습니다. 다양한 크기와 복잡도를 가진 다이어그램이 포함되어 있습니다.

## 1. Extremely Wide Flowchart (가로 스크롤/확대 테스트)
매우 넓게 퍼지는 형태의 플로우차트입니다. 화면 폭을 넘어가면 스크롤이 생기거나 축소되어야 하며, 클릭 시 원본 크기로 볼 수 있어야 합니다.

```mermaid
graph LR
    Start[Start Process] --> Step1[Step 1: Initialize System]
    Step1 --> Step2[Step 2: Load Configuration from Environment Variables]
    Step2 --> Step3{Is Configuration Valid?}
    Step3 -- Yes --> Step4[Step 4: Connect to Primary Database Cluster]
    Step3 -- No --> Error1[Error: Invalid Configuration Detected. Aborting Process.]
    Step4 --> Step5{Connection Successful?}
    Step5 -- Yes --> Step6[Step 6: Authenticate User Credentials against Active Directory]
    Step5 -- No --> Error2[Error: Database Connection Timeout. Retrying in 5 seconds...]
    Step6 --> Step7{Authentication Passed?}
    Step7 -- Yes --> Step8[Step 8: Fetch User Profile and Permissions]
    Step7 -- No --> Error3[Error: Invalid Credentials. Logging attempt.]
    Step8 --> Step9[Step 9: Render Dashboard Dashboard with User Specific Data]
    Step9 --> End[End Process]
```

## 2. Complex Sequence Diagram (세로/가로 스크롤 테스트)
참여자가 많고 메시지 길이가 길어 다이어그램이 커지는 시퀀스 다이어그램입니다.

```mermaid
sequenceDiagram
    participant User as End User Client
    participant API as API Gateway (Kong)
    participant Auth as Authentication Service
    participant ServiceA as Microservice A (Catalog)
    participant ServiceB as Microservice B (Cart)
    participant DB as Main Database (PostgreSQL)

    User->>API: GET /api/v1/products?category=electronics&sort=price_asc
    API->>Auth: Validate JWT Token (Bearer eyJhb...)
    Auth-->>API: Token Valid (User ID: 12345)
    API->>ServiceA: Forward Request: Fetch Electronics
    ServiceA->>DB: SELECT * FROM products WHERE category = 'electronics' ORDER BY price ASC
    DB-->>ServiceA: Return 500 rows
    ServiceA-->>API: Return JSON Array of Products
    API-->>User: 200 OK (Products JSON)

    User->>API: POST /api/v1/cart/add { productId: 987, qty: 1 }
    API->>Auth: Validate JWT Token
    Auth-->>API: Token Valid
    API->>ServiceB: Forward Request: Add to Cart
    ServiceB->>DB: INSERT INTO cart_items (user_id, product_id, qty) VALUES (12345, 987, 1)
    DB-->>ServiceB: Insert Successful
    ServiceB-->>API: 201 Created (Cart Updated)
    API-->>User: 201 Created
    
    Note over User,DB: This is a very long note that spans across multiple participants to test how the renderer handles extremely wide text blocks inside a sequence diagram. It should force the diagram to expand horizontally.
```

## 3. Large Gantt Chart (복잡도 테스트)
다수의 항목이 포함된 간트 차트입니다.

```mermaid
gantt
    title Q3-Q4 Product Development Roadmap
    dateFormat  YYYY-MM-DD
    axisFormat  %m-%d

    section Planning & Design
    Requirements Gathering     :done,    req1, 2026-07-01, 2026-07-15
    Architecture Design        :done,    arch1, 2026-07-16, 2026-07-31
    UI/UX Mockups              :active,  ui1, 2026-08-01, 2026-08-20

    section Backend Development
    Database Schema Migration  :         db1, 2026-08-10, 2026-08-25
    Core API Implementation    :         api1, 2026-08-20, 2026-09-30
    Payment Gateway Integration:         pay1, 2026-09-15, 2026-10-15

    section Frontend Development
    Dashboard Implementation   :         dash1, 2026-08-25, 2026-09-20
    Shopping Cart UI           :         cart1, 2026-09-10, 2026-10-05
    Checkout Flow              :         check1, 2026-09-25, 2026-10-20

    section Testing & QA
    Unit Testing               :         test1, 2026-09-01, 2026-10-25
    Integration Testing        :         test2, 2026-10-10, 2026-11-05
    User Acceptance Testing    :         uat1, 2026-11-01, 2026-11-15

    section Deployment
    Staging Deployment         :         dep1, 2026-11-16, 2026-11-20
    Production Release         :         dep2, 2026-11-25, 2026-11-26
```

## 4. Class Diagram (관계 복잡도 테스트)
클래스 간의 복잡한 관계를 나타내는 다이어그램입니다.

```mermaid
classDiagram
    class Animal {
      +int age
      +String gender
      +isMammal()
      +mate()
    }
    class Duck {
      +String beakColor
      +swim()
      +quack()
    }
    class Fish {
      -int sizeInFeet
      -canEat()
    }
    class Zebra {
      +bool is_wild
      +run()
    }
    
    Animal <|-- Duck
    Animal <|-- Fish
    Animal <|-- Zebra
    
    class FleetSystem {
      <<interface>>
      +dispatchCarrier()
      +monitorJobs()
    }
    
    class Carrier {
      +String id
      +String role
      +executeTask()
    }
    
    FleetSystem "1" *-- "many" Carrier : manages
```