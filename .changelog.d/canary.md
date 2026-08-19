### fleet-console
#### Changed
- Send Grok turns to xAI's own Responses endpoint instead of the Grok CLI proxy, which queued roughly a third of requests behind a 5 to 18 second wait. The same subscription and quota back both routes.
  ko: Grok 턴을 Grok CLI 프록시 대신 xAI 자체 Responses 엔드포인트로 보냅니다. 프록시는 세 번에 한 번꼴로 5~18초 대기가 붙었습니다. 두 경로 모두 같은 구독과 할당량을 씁니다.
