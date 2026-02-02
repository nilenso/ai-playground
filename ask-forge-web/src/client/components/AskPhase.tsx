import type { ConnectionState } from "../types.ts";
import { Sidebar } from "./Sidebar.tsx";

interface AskPhaseProps {
	connection: ConnectionState;
	inputValue: string;
	setInputValue: (value: string) => void;
	isAsking: boolean;
	handleKeyDown: (e: React.KeyboardEvent) => void;
	handleDisconnect: () => void;
	askTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
	sidebarProps: React.ComponentProps<typeof Sidebar>;
}

export function AskPhase({
	connection,
	inputValue,
	setInputValue,
	isAsking,
	handleKeyDown,
	handleDisconnect,
	askTextareaRef,
	sidebarProps,
}: AskPhaseProps) {
	return (
		<div className="app-container phase-ask">
			<Sidebar {...sidebarProps} />
			<div className="app-main">
				<div className="ask-content">
					<h2 className="greeting">What can I help with?</h2>

					<div className="input-container">
						<div className="input-wrapper">
							<textarea
								ref={askTextareaRef}
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder='Ask anything... "Explain the architecture"'
								className="main-input"
								disabled={isAsking}
								rows={3}
							/>
						</div>
					</div>

					<div className="repo-status">
						<span className="status-indicator connected" />
						<span className="repo-name">{connection.repoName}</span>
						{connection.commitish && <code className="commit-badge">{connection.commitish.slice(0, 7)}</code>}
						<button type="button" className="disconnect-link" onClick={handleDisconnect}>
							Disconnect
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
