package com.dotobokuri.fleet.mobile

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FleetMobileModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FleetConsoleView")

    View(FleetConsoleView::class) {
      Events("onFleetEvent")

      AsyncFunction("retry") { view: FleetConsoleView ->
        view.retry()
      }

      AsyncFunction("resume") { view: FleetConsoleView ->
        view.resume()
      }

      AsyncFunction("submitAccessLink") { view: FleetConsoleView, link: String ->
        view.submitAccessLink(link)
      }

      AsyncFunction("connectTo") { view: FleetConsoleView, origin: String ->
        view.connectTo(origin)
      }

      AsyncFunction("removeTarget") { view: FleetConsoleView, origin: String ->
        view.removeTarget(origin)
      }

      AsyncFunction("listTargets") { view: FleetConsoleView ->
        view.listTargets()
      }

      AsyncFunction("navigateBack") { view: FleetConsoleView ->
        view.navigateBack()
      }
    }
  }
}
