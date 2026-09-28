// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";

async function loadPage(storage: Storage) {
  vi.resetModules();
  vi.stubGlobal("window", { sessionStorage: storage });
  return import("../core/client/src/chrome/expanded-surface/store.js");
}

afterEach(() => { vi.unstubAllGlobals(); });

// 기존 부팅 검사는 Operation 복원만 다룬다. 주소 없는 확대 표면도 새 문서가 된 뒤
// 같은 탭·origin의 사용자 배치로 돌아오고, 닫은 표면을 되살리지 않는 수명주기를 검증한다.
it("restores each Console's expanded surfaces across document replacement without resurrecting closed panes", async () => {
  const first = document.createElement("iframe");
  const second = document.createElement("iframe");
  second.src = "https://remote.example/console/";
  document.body.append(first, second);
  // origin이 다른 두 문서의 실제 탭 저장소를 각 페이지 부팅에 넘긴다.
  const home = first.contentWindow!.sessionStorage;
  const remote = second.contentWindow!.sessionStorage;
  home.clear();
  remote.clear();
  try {
    let page = await loadPage(home);
    const objectives = page.openExpandedSurface({ surfaceId: "objectives" });
    const documentId = page.openExpandedSurface({ surfaceId: "pane", params: { paneId: "reader", document: "home" } });
    page.setExpandedSurfaceWeights([2, 3]);
    page.focusExpandedSurface(objectives);
    const homeState = page.getExpandedSurfaceState();

    page = await loadPage(remote);
    expect(page.getExpandedSurfaceState().instances).toEqual([]);
    page.openExpandedSurface({ surfaceId: "pane", params: { paneId: "reader", document: "remote" } });
    const remoteState = page.getExpandedSurfaceState();

    page = await loadPage(home);
    expect(page.getExpandedSurfaceState()).toEqual(homeState);
    const split = page.openExpandedSurface({ surfaceId: "objectives", mode: "split" });
    expect(split).not.toBe(objectives);
    page.closeExpandedSurface(documentId);
    page.closeExpandedSurfacesOf("objectives");

    page = await loadPage(remote);
    expect(page.getExpandedSurfaceState()).toEqual(remoteState);
    page.replaceExpandedSurfaceParams(remoteState.instances[0]!.instanceId, { paneId: "reader", document: "updated" });
    page = await loadPage(remote);
    expect(page.getExpandedSurfaceState().instances[0]!.params.document).toBe("updated");
    page.closeAllExpandedSurfaces();

    page = await loadPage(home);
    expect(page.getExpandedSurfaceState()).toEqual({ instances: [], focusedInstanceId: null });
    page = await loadPage(remote);
    expect(page.getExpandedSurfaceState()).toEqual({ instances: [], focusedInstanceId: null });
  } finally {
    home.clear();
    remote.clear();
    first.remove();
    second.remove();
  }
});
