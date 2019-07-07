// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';


import { TextEditor } from "vscode";
import { createSourceFile, Node, ScriptTarget, SyntaxKind, isTemplateSpan } from "typescript";

export interface Range {
    start: number;
    end: number;
}

export interface SelectionStrategy {
    grow(editor: TextEditor): Range[];
}

function pathToPositionInternal(node: Node, start: number, end: number, path: Node[]) {
    const nodeStart = node.getFullStart();
    const nodeEnd = node.getEnd();
    if (start < nodeStart || end > nodeEnd) {
        return;
    }
    path.push(node);
    node.forEachChild(child => {
        pathToPositionInternal(child, start, end, path);
    });
}

function pathToPosition(node: Node, start: number, end: number): Node[] {
    const path: Node[] = [];
    pathToPositionInternal(node, start, end, path);
    return path;
}

const WHITESPACE = /\s/;

function collapseWhitespace(source: string, range: Range): Range {
    let i = range.start;
    let leftRemove = 0;
    while (i < source.length && WHITESPACE.test(source.charAt(i))) {
        i++;
        leftRemove++;
    }
    let j = range.end - 1;
    let rightRemove = 0;
    while (j >= 0 && WHITESPACE.test(source.charAt(j))) {
        j--;
        rightRemove++;
    }
    return {
        start: range.start + leftRemove,
        end: range.end - rightRemove
    };
}

export function nodeToRange(node: Node): Range | undefined {
    let ds = 0;
    let de = 0;
    if (node.kind === SyntaxKind.TemplateHead) {
        ds = 2;
        de = -2;
    }
    if (node.kind === SyntaxKind.TemplateTail) {
        ds = 1;
        de = -1;
    }
    if (node.kind === SyntaxKind.TemplateMiddle) {
        ds = 1;
        de = -2;
    }
    if (isTemplateSpan(node)) {
        ds = -2;
        de = -node.literal.getFullWidth() + 1;
    }
    return {
        start: node.getFullStart() + ds,
        end: node.getEnd() + de
    };
}

export class TypescriptStrategy implements SelectionStrategy {
    grow(editor: TextEditor): Range[] {
        const doc = editor.document;
        const startRanges = editor.selections.map(selection => ({
            start: doc.offsetAt(selection.start),
            end: doc.offsetAt(selection.end)
				}));
				console.log('input Ranges', startRanges);
        const text = doc.getText();
        const node = createSourceFile(doc.fileName, text, ScriptTarget.Latest);
        const outRanges = startRanges
            .map(range => {
                const path = pathToPosition(node, range.start, range.end);
                let expansionNode: Node | undefined;
                let expansionRange: Range | undefined;
                for (let i = path.length - 1; i >= 0; i--) {
                    const candidate = path[i];
                    const candidateRange = nodeToRange(candidate);
                    if (candidateRange === undefined) {
                        continue;
                    }
                    const outRange = collapseWhitespace(text, candidateRange);
                    if (
                        (outRange.start < range.start && outRange.end >= range.end) ||
                        (outRange.end > range.end && outRange.start <= range.start)
                    ) {
                        expansionNode = candidate;
                        expansionRange = candidateRange;
                        break;
                    }
                }
                if (expansionNode === undefined || expansionRange === undefined) {
                    return undefined;
                }
                const outRange = collapseWhitespace(text, expansionRange);
                return outRange;
            })
            .filter(range => range !== undefined)
            .map(range => range!);
        return outRanges;
    }
}

function areSelectionsEqual(selections: vscode.Selection[], otherSelections: vscode.Selection[]): boolean {
    return (
        selections.length === otherSelections.length &&
        selections.every((selection, index) => selection.isEqual(otherSelections[index]))
    );
}

class VerySmartSelect {
    private strategies: { [key: string]: SelectionStrategy | undefined } = {};

    private selectionsHistory: vscode.Selection[][] = [];
    private windowSelectionListener: vscode.Disposable;
    private didUpdateSelections: boolean = false;

    constructor() {
        this.strategies["typescript"] = new TypescriptStrategy();
        this.strategies["typescriptreact"] = new TypescriptStrategy();
        this.strategies["javascript"] = new TypescriptStrategy();
        this.strategies["javascriptreact"] = new TypescriptStrategy();
        this.strategies["json"] = new TypescriptStrategy();
        this.strategies["jsonc"] = new TypescriptStrategy();

        this.windowSelectionListener = vscode.window.onDidChangeTextEditorSelection(e => {
            if (this.didUpdateSelections) {
                this.didUpdateSelections = false;
            } else {
                this.selectionsHistory = [];
            }
        });
    }

    public grow() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const doc = editor.document;
        const strategy = this.strategies[doc.languageId];
        if (strategy === undefined) {
            vscode.commands.executeCommand("editor.action.smartSelect.grow");
            return;
				}
        const ranges = strategy.grow(editor);
				console.log('output ranges', ranges);
        const selections = ranges.map(
            range => new vscode.Selection(doc.positionAt(range.start), doc.positionAt(range.end))
        );
        this.updateSelectionsHistory(editor.selections);
        this.updateSelections(selections);
    }

    public shrink() {
        const selections = this.selectionsHistory.pop();
        if (selections) {
            this.updateSelections(selections);
        } else {
            vscode.commands.executeCommand("editor.action.smartSelect.shrink");
        }
    }

    public dispose() {
        this.windowSelectionListener.dispose();
    }

    private updateSelections(selections: vscode.Selection[]) {
        const editor = vscode.window.activeTextEditor;
        if (editor && selections.length > 0) {
            this.didUpdateSelections = true;
            editor.selections = selections;
        }
    }

    private updateSelectionsHistory(selections: vscode.Selection[]) {
        const lastSelections =
            this.selectionsHistory.length > 0
                ? this.selectionsHistory[this.selectionsHistory.length - 1]
                : undefined;
        if (lastSelections === undefined || !areSelectionsEqual(lastSelections, selections)) {
            this.selectionsHistory.push([...selections]);
        }
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	const verySmartSelect = new VerySmartSelect();

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('extension.selectParameters', () => {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		verySmartSelect.grow();
		vscode.window.showInformationMessage('Hello World!');
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
