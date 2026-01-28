import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Visualizer } from "./Visualizer.tsx";

const root = document.getElementById("root");

if (root) {
	createRoot(root).render(
		<StrictMode>
			<Visualizer />
		</StrictMode>,
	);
}
