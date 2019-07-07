import * as vscode from 'vscode';


import { TextEditor } from "vscode";
import { createSourceFile, Node, ScriptTarget, SyntaxKind, isTemplateSpan, JsxEmit } from "typescript";

interface Range {
    start: number;
    end: number;
}

interface SelectionStrategy {
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

function getPathOfNodesInRange(node: Node, start: number, end: number): Node[] {
    const path: Node[] = [];
    pathToPositionInternal(node, start, end, path);
    return path;
}

const WHITESPACE = /\s/;

function collapseWhitespace(editor: TextEditor, range: Range): Range {
    const source = editor.document.getText();
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

function nodeToRange(node: Node) {
    let ds = 0;
    let de = 0;
    // if (node.kind === SyntaxKind.TemplateHead) {
    //     ds = 2;
    //     de = -2;
    // }
    // if (node.kind === SyntaxKind.TemplateTail) {
    //     ds = 1;
    //     de = -1;
    // }
    // if (node.kind === SyntaxKind.TemplateMiddle) {
    //     ds = 1;
    //     de = -2;
    // }
    // if (isTemplateSpan(node)) {
    //     ds = -2;
    //     de = -node.literal.getFullWidth() + 1;
    // }
    const range: Range = {
        start: node.getFullStart() + ds,
        end: node.getEnd() + de
    };
		
    return range;
}

const getSourceFile = (editor: TextEditor) => {
    const doc = editor.document;
    const text = editor.document.getText();
    return createSourceFile(doc.fileName, text, ScriptTarget.Latest);
};

const rangeToNode = (editor: TextEditor, range: Range) => {

    const sourceFileNode = getSourceFile(editor);
    const pathOfNodes = getPathOfNodesInRange(sourceFileNode, range.start, range.end);

    for (let i = pathOfNodes.length - 1; i >= 0; i--) {
        const node = pathOfNodes[i];
        const candidateRange = nodeToRange(node);
        const outRange = collapseWhitespace(editor, candidateRange);
        if (
            (outRange.start < range.start && outRange.end >= range.end) ||
            (outRange.end > range.end && outRange.start <= range.start)
        ) {
            return node;
        }
    }
};

const growRange = (editor: TextEditor, range: Range) => {
    const expansionNode = rangeToNode(editor, range);
    if (expansionNode === undefined) {
        return;
    }
    const expansionRange = nodeToRange(expansionNode);
    const outRange = collapseWhitespace(editor, expansionRange);
    return outRange;
};

class TypescriptStrategy implements SelectionStrategy {
    grow(editor: TextEditor): Range[] {
        const doc = editor.document;
        const startRanges = editor.selections.map(selection => ({
            start: doc.offsetAt(selection.start),
            end: doc.offsetAt(selection.end)
        }));
        const outRanges = startRanges
            .map(range => {
                return growRange(editor, range);
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

const rangeIsJsxElement = (editor: TextEditor, range: Range) => {
    const node = rangeToNode(editor, range);
    if (!node) {
        return;
    }
    return (
        node.kind === SyntaxKind.JsxSelfClosingElement ||
        node.kind === SyntaxKind.JsxOpeningElement ||
        node.kind === SyntaxKind.JsxElement
    );
};
const growUntilJsxElement = (editor: TextEditor, range: Range) => {
    let grownRange: Range | undefined = range;
    let rLimit = 100;
    let r = 0;
    while(!rangeIsJsxElement(editor, grownRange)) {
        grownRange = growRange(editor, grownRange);
        if (grownRange === undefined) {
            return;
        }
        r += 1;
        if (r > rLimit) {
            console.error('WARNING, rLimit exceeded');
            return;
        }
    }
    return grownRange;
};
const getAllChildNodes = (node: Node) => {
    let nodes: Node[] = [];
    node.forEachChild((childNode) => {
        const nodesOfChild = getAllChildNodes(childNode);
        nodes = [...nodes, childNode, ...nodesOfChild];
    });
    return nodes;
};

const findParams = (strategy: SelectionStrategy, editor: TextEditor) => {
    const doc = editor.document;
    const text = doc.getText();
    const sourceFile = createSourceFile(doc.fileName, text, ScriptTarget.Latest);
    const ranges = strategy.grow(editor);
    const jsxElementRanges = ranges.map((range) => {
        const maybeRange = growUntilJsxElement(editor, range);
        return maybeRange;
    });
    const paramRanges: Range[] = [];
    jsxElementRanges.forEach((maybeRange) => {
        if (!maybeRange) {
            return;
        }
        const node = rangeToNode(editor, maybeRange);
        if (!node) {
            return;
        }
        const childNodes = getAllChildNodes(node);
        // use this for debugging
        // childNodes.forEach((childNode) => {
        //     const childNodeText = childNode.getText(sourceFile);
        //     console.log('kind', childNode.kind, 'childNodeText', childNodeText);                    
        // });
        const jsxAttributesNode = childNodes.find((childNode) => {
            return childNode.kind === SyntaxKind.JsxAttributes;
        });

        if (!jsxAttributesNode) {
            return;
        }
        jsxAttributesNode.forEachChild((jsxAttributeNode) => {

            if (jsxAttributeNode.kind !== SyntaxKind.JsxAttribute) {
                return;
            }
            const jsxAttributeNodeChildNodes = jsxAttributeNode.getChildren(sourceFile);
            const [jsxAttributeIdentifierNode] = jsxAttributeNodeChildNodes;


            paramRanges.push(
                collapseWhitespace(
                    editor,
                    nodeToRange(jsxAttributeIdentifierNode),
                )
            );
        });
    });
	return paramRanges;
};

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
        const paramRanges = findParams(strategy, editor);
        if (!paramRanges.length) {
            return;
        }
        const selections = paramRanges.map(
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

export function activate(context: vscode.ExtensionContext) {

	const verySmartSelect = new VerySmartSelect();

	let disposable = vscode.commands.registerCommand('extension.selectParameters', () => {
		verySmartSelect.grow();
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
