---
branch: feat/codex-commodore-knowledge
---

### fleet-console
#### Changed
- Each commodore now keeps its own Wiki, and the Wiki you already use moves there automatically the next time Console starts; old Wiki links keep opening.
  ko: 이제 사령관마다 자기 위키를 갖고, 쓰던 위키는 다음에 Console을 켤 때 자동으로 옮겨집니다. 예전 위키 링크도 그대로 열립니다.
#### Removed
- Wiki copies kept in a project's `.fleet/knowledge` folder are no longer imported, and Files no longer offers to open such copies in Codex; the files stay in the project untouched.
  ko: 프로젝트의 `.fleet/knowledge` 폴더에 남은 옛 위키 사본은 더 이상 가져오지 않으며, Files에서 그 사본을 Codex로 여는 안내도 사라집니다. 파일은 프로젝트에 그대로 남습니다.
