import {
    commands, window, workspace,
    Uri, ThemeIcon,
    InputBoxValidationSeverity, QuickPickItem
} from 'vscode';
import { MultiStepInput } from './multiStepInput';
import { execSync } from 'child_process';
import { EOL } from 'os';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { PythonShell, PythonShellError } from './python';
import * as blocks from './blockFilter';
import { getBlockFilesTree } from './moduleTree';

export type ModtoolClosure = (
    cmd: 'info' | 'add' | 'bind' | 'rename' | 'disable' | 'rm' | 'update' | 'makeyaml',
    ...args: string[]
) => Promise<string | PythonShellError>;

export class ModtoolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModtoolError';
        Object.setPrototypeOf(this, ModtoolError.prototype);
    }
}

export function validateBlockName(existingBlocks: Set<string>) {
    return (value: string) => {
        let name = value.trim();
        if (!name.length) {
            return {
                message: 'Name cannot be empty',
                severity: InputBoxValidationSeverity.Error,
            };
        }
        if (!/^([\w,\_]+)$/.test(name)) {
            return {
                message: 'Name can only contain ASCII letters, digits and underscores',
                severity: InputBoxValidationSeverity.Error,
            };
        }
        if (name.length < 3) {
            return {
                message: 'Descriptive names usually contain at least 3 symbols',
                severity: InputBoxValidationSeverity.Warning,
                then: null,
            };
        }
        if (existingBlocks.has(name)) {
            return {
                message: 'Block with that name is already present',
                severity: InputBoxValidationSeverity.Error,
            };
        }
        return null;
    };
}

/**
 * Create a new OOT module project.
 * 
 * This command runs `gr_modtool newmod %name` in the shell, creating a new CMake project and opening the created folder. 
 */
export async function createModule(shell: PythonShell) {
    const newmodName = await window.showInputBox({
        title: 'GNURadio: New OOT Module',
        placeHolder: 'Enter Module Name...',
        validateInput(value) {
            let name = value.trim();
            if (!name.length) {
                return {
                    message: 'Name cannot be empty',
                    severity: InputBoxValidationSeverity.Error,
                };
            }
            if (!/^([\w,\_,\-,\.]+)$/.test(name)) {
                return {
                    message: 'Name can only contain ASCII letters, digits, and the characters . - _',
                    severity: InputBoxValidationSeverity.Error,
                };
            }
            if (name.length < 3) {
                return {
                    message: 'Descriptive names usually contain at least 3 symbols',
                    severity: InputBoxValidationSeverity.Warning,
                    then: null,
                };
            }
            return null;
        },
    });
    if (!newmodName) {
        throw Error('No valid name provided');
    }
    const parentDir = await window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Create module in directory'
    }).then(
        (value) => value && value.length ? value[0] : undefined,
        () => undefined,
    );
    if (!parentDir) {
        throw Error('No directory provided');
    }
    const newmodPath = Uri.joinPath(parentDir, `gr-${newmodName}`).fsPath;
    if (existsSync(newmodPath)) {
        throw Error('Directory already exists');
    }
    shell.outputChannel.appendLine(`\n[Running] gr_modtool newmod ${newmodName}`);
    await shell.run(['newmod.py', newmodName], parentDir.fsPath);
    if (await window.showInformationMessage(`New GNURadio module "${newmodName}" created in ${newmodPath}.`, 'Open Directory') === 'Open Directory') {
        return commands.executeCommand<void>('vscode.openFolder', Uri.file(newmodPath));
    }
}

/**
 * Query information about the OOT module.
 * 
 * This command runs `gr_modtool info` in the shell and returns a JSON map.
 */
export async function getModuleInfo(execModtool: ModtoolClosure, json: boolean = false) {
    const output = json
        ? await execModtool('info', '--python-readable')
        : await execModtool('info');
    if (output instanceof PythonShellError) {
        if (output.log?.includes('ImportError')) {
            throw new ModtoolError(
                'Python modules for GNURadio not found. ' +
                'Please check if GNURadio is installed on your system.');
        } else {
            throw new ModtoolError(output.message);
        }
    }
    if (json) {
        return JSON.parse(output.trim().replace(/\'/g, '"'));
    }
    await window.showInformationMessage(
        'GNURadio Module Info', {
        modal: true,
        detail: output.split(EOL).map(line => line.trim()).join(EOL),
    });
}

/**
 * Create a new block in the OOT module.
 * 
 * This command runs `gr_modtool add` in the shell, creating source files and including them into CMakeLists.
 * 
 * TODO: Create an HTML form instead of a multi-step input box
 */
export async function createBlock(execModtool: ModtoolClosure, extRoot: Uri, cwd: string, moduleName: string) {
    const existingBlocks = blocks.getAllBlocks(cwd, moduleName);

    interface State {
        title: string;
        step: number;
        totalSteps: number;
        copyright?: string;
        name?: string;
        blockType?: QuickPickItem;
        language?: QuickPickItem;
        addCppTest?: boolean;
        addPythonTest?: boolean;
        finished: boolean;
    }

    async function inputAuthor(input: MultiStepInput, state: State) {
        // TODO: Remember current value when navigating back.
        state.copyright = await input.showInputBox({
            title: state.title,
            step: 1,
            totalSteps: state.totalSteps,
            value: state.copyright || '',
            prompt: 'Please specify the copyright holder',
        });
        return (input: MultiStepInput) => inputName(input, state);
    }

    async function inputName(input: MultiStepInput, state: State) {
        // TODO: Remember current value when navigating back.
        state.name = await input.showInputBox({
            title: state.title,
            step: 2,
            totalSteps: state.totalSteps,
            value: state.name || '',
            prompt: 'Choose a unique name for the block',
            validateInput: validateBlockName(existingBlocks),
        });
        return (input: MultiStepInput) => pickBlockType(input, state);
    }

    async function pickBlockType(input: MultiStepInput, state: State) {
        const pick = await input.showQuickPick(
            [
                { label: 'general', description: 'gr::block', detail: 'General-purpose block type' },
                { label: 'sync', description: 'gr::sync_block', detail: 'Block with synchronous 1:1 input-to-output' },
                { label: 'decimator', description: 'gr::sync_decimator', detail: 'Block with synchronous N:1 input-to-output' },
                { label: 'interpolator', description: 'gr::sync_interpolator', detail: 'Block with synchronous N:1 input-to-output' },
                { label: 'source', description: 'gr::sync_block', detail: 'Source block with outputs, but no stream inputs' },
                { label: 'sink', description: 'gr::sync_block', detail: 'Sink block with inputs, but no stream outputs' },
                { label: 'tagged_stream', description: 'gr::tagged_stream_block', detail: 'Block with input-to-output flow controlled by input stream tags (e.g. packetized streams)' },
                { label: 'hier', description: 'gr::hier_block2', detail: 'Hierarchical container block for other blocks; usually can be described by a flowgraph' },
                { label: 'noblock', detail: 'C++ or Python class' },
            ],
            {
                title: state.title,
                step: 3,
                totalSteps: state.totalSteps,
                placeHolder: 'Pick block type',
                activeItem: state.blockType,
            }
        );
        state.blockType = pick[0];
        state.totalSteps = state.blockType.label === 'noblock' ? 4 : 5;
        return (input: MultiStepInput) => pickLanguage(input, state);
    }

    async function pickLanguage(input: MultiStepInput, state: State) {
        const pick = await input.showQuickPick(
            [
                {
                    label: 'Python',
                    description: 'python',
                    iconPath: Uri.joinPath(extRoot, 'media', 'file_type_python.svg')
                },
                {
                    label: 'C++',
                    description: 'cpp',
                    iconPath: Uri.joinPath(extRoot, 'media', 'file_type_cpp3.svg')
                },
            ],
            {
                title: state.title,
                step: 4,
                totalSteps: state.totalSteps,
                placeHolder: 'Pick implementation language',
                activeItem: state.language,
            }
        );
        state.language = pick[0];
        if (state.blockType?.label === 'noblock' && state.language?.description === 'python') {
            state.finished = true;
            return;
        }
        state.totalSteps = 5;
        return (input: MultiStepInput) => pickTests(input, state);
    }

    async function pickTests(input: MultiStepInput, state: State) {
        let testLanguages: QuickPickItem[] = [];
        if (state.blockType?.label !== 'noblock') {
            testLanguages.push({
                label: 'Python',
                description: 'python',
                iconPath: Uri.joinPath(extRoot, 'media', 'file_type_python.svg')
            });
        }
        if (state.language?.description === 'cpp') {
            testLanguages.push({
                label: 'C++',
                description: 'cpp',
                iconPath: Uri.joinPath(extRoot, 'media', 'file_type_cpp3.svg')
            });
        }
        const picks = await input.showQuickPick(
            testLanguages, {
            title: state.title,
            step: 5,
            totalSteps: state.totalSteps,
            placeHolder: 'Add QA code',
            canPickMany: true,
        });
        for (var pick of picks) {
            if (pick.description === 'cpp') {
                state.addCppTest = true;
            } else if (pick.description === 'python') {
                state.addPythonTest = true;
            }
        }
        state.finished = true;
    }

    // TODO: Arguments?

    let state = <State>{ title: 'GNURadio: Create Block', totalSteps: 5, finished: false };
    try {
        const gitPath = workspace.getConfiguration('git').get<string | string[]>('path');
        const gitCmd = gitPath
            ? Array.isArray(gitPath)
                ? gitPath.length > 0 ? gitPath[0] : undefined
                : gitPath
            : undefined;
        state.copyright = execSync(`${gitCmd ?? 'git'} config user.name`, { encoding: 'utf8' });
    }
    catch (_) { }

    await MultiStepInput.run(input => inputAuthor(input, state));
    if (!state.finished) {
        return;
    }

    let args = [
        state.name!,
        '--block-type',
        state.blockType!.label,
        '--lang',
        state.language!.description!,
    ];
    if (state.copyright) {
        args.push('--copyright', state.copyright);
    }
    if (state.addCppTest) {
        args.push('--add-cpp-qa');
    }
    if (state.addPythonTest) {
        args.push('--add-python-qa');
    }
    const result = await execModtool('add', ...args);
    if (result instanceof PythonShellError) {
        throw new ModtoolError(result.log ?? result.message);
    }
    const blockPath = state.language!.description === 'python'
        ? resolve(cwd, 'python', moduleName, `${state.name}.py`)
        : resolve(cwd, 'include', 'gnuradio', moduleName, `${state.name}.h`);
    return commands.executeCommand<void>('vscode.open', Uri.file(blockPath));
}

/**
 * Create Python bindings for the block.
 * 
 * This command runs `gr_modtool bind %f` in the shell, generating pybind11 code based on the block's C++ header.
 */
export async function createPythonBindings(execModtool: ModtoolClosure, cwd: string, moduleName: string, blockName?: string) {
    const cppBlocks = blocks.getCppBlocks(cwd, moduleName);
    if (cppBlocks.length === 0) {
        return window.showInformationMessage('No C++ headers found');
    }
    if (!blockName) {
        blockName = window.activeTextEditor?.document.fileName;
        if (blockName) {
            blockName = blocks.mapCppBlocks(blockName);
            if (!cppBlocks.includes(blockName)) {
                blockName = undefined;
            }
        }
        blockName = await quickPickWithRegex(
            cppBlocks, {
            title: 'GNURadio: Python Bindings',
            placeholder: 'Enter block name or regular expression...',
            value: blockName,
        });
        if (!blockName) {
            return;
        }
    }
    let successMessage: string;
    if (cppBlocks.includes(blockName)) {
        const blockBindPath = join('python', moduleName, 'bindings', `${blockName}_python.cc`);
        successMessage = `Python bindings written to "${blockBindPath}"`;
    } else {
        const re = RegExp(blockName);
        const matchingBlocks = cppBlocks.filter(block => re.test(block));
        successMessage = 'Python bindings created for blocks: ', matchingBlocks.join(', ');
    }
    const result = await execModtool('bind', blockName);
    if (result instanceof PythonShellError) {
        throw new ModtoolError(result.log ?? result.message);
    }
    return window.showInformationMessage(successMessage);
}

/**
 * Convert old XML block definitions to YAML.
 * 
 * This command runs `gr_modtool update %f`, generating a new YAML definition and deleting the old XML.
 */
export async function convertXmlToYaml(execModtool: ModtoolClosure, cwd: string, moduleName: string, blockName?: string) {
    const xmlBlocks = blocks.getXmlBlocks(cwd, moduleName);
    if (xmlBlocks.length === 0) {
        return window.showInformationMessage('No XML found, no need to update!');
    }
    if (!blockName) {
        blockName = window.activeTextEditor?.document.fileName;
        if (blockName) {
            blockName = blocks.mapGrcBlocks(moduleName, '.xml')(blockName);
            if (!xmlBlocks.includes(blockName)) {
                blockName = undefined;
            }
        }
        blockName = await quickPick(
            xmlBlocks, {
            title: 'GNURadio: Convert XML to YAML',
            placeholder: 'Enter block name...',
            value: blockName,
        });
    }
    if (blockName) {
        const result = await execModtool('update', blockName);
        if (result instanceof PythonShellError) {
            throw new ModtoolError(
                result.log?.trimEnd().split(EOL).pop()
                ?? result.message);
        }
        return window.showInformationMessage(`Block definition written to "grc/${moduleName}_${blockName}.block.yml"`);
    }
    const updateAll = await window.showWarningMessage('No block name provided! Update all definitions?', 'Yes', 'No');
    if (updateAll === 'Yes') {
        const result = await execModtool('update', '--complete');
        if (result instanceof PythonShellError) {
            throw new ModtoolError(
                result.log?.trimEnd().split(EOL).pop()
                ?? result.message);
        }
        return window.showInformationMessage(`Block definitions written to "grc/"`);
    }
}

/**
 * Make YAML definition the block implementation.
 * 
 * This command runs `gr_modtool makeyaml %f`, generating a YAML definition based on the block's implementation.
 * 
 * TODO: `gr_modtool makeyaml` does not work correctly.
 */
export async function makeYamlFromImpl(execModtool: ModtoolClosure, cwd: string, moduleName: string, blockName?: string) {
    const cppBlocks = blocks.getCppImplFiles(cwd);
    if (cppBlocks.length === 0) {
        return window.showInformationMessage('No C++ blocks found');
    }
    if (!blockName) {
        blockName = window.activeTextEditor?.document.fileName;
        if (blockName) {
            blockName = blocks.mapCppImplFiles(blockName);
            if (!cppBlocks.includes(blockName)) {
                blockName = undefined;
            }
        }
        blockName = await quickPickWithRegex(
            cppBlocks, {
            title: 'GNURadio: Make YAML from implementation',
            placeholder: 'Enter block name or regular expression...',
            value: blockName,
        });
        if (!blockName) {
            return;
        }
    }
    const result = await execModtool('makeyaml', blockName);
    if (result instanceof PythonShellError) {
        throw new ModtoolError(result.log ?? result.message);
    }
    let blockYamlPath = cppBlocks.includes(blockName)
        ? join('grc', `${moduleName}_${blockName}.block.yml`)
        : 'grc';
    return window.showInformationMessage(`Block definition written to "${blockYamlPath}"`);
}

/**
 * Disable the block.
 * 
 * This command runs `gr_modtool disable %f`, commenting out all related lines in CMakeLists.
 * 
 * TODO: `gr_modtool disable` does not work correctly.
 */
export async function disableBlock(execModtool: ModtoolClosure, cwd: string, moduleName: string, blockName?: string) {
    const existingBlocks = blocks.getAllBlocks(cwd, moduleName);
    if (!blockName) {
        blockName = window.activeTextEditor?.document.fileName;
        if (blockName) {
            blockName = blocks.filteredMapBlockFile(blockName, moduleName);
        }
        blockName = await quickPickWithRegex(
            Array.from(existingBlocks), {
            title: 'GNURadio: Disable Blocks',
            placeholder: 'Enter block name or regular expression...',
            value: blockName,
        });
        if (!blockName) {
            return;
        }
    }
    let warningMessage: string;
    let successMessage: string;
    let detailMessage: string[] = [];
    if (existingBlocks.has(blockName)) {
        warningMessage = `Are you sure you want to disable "${blockName}"?`;
        successMessage = `Block "${blockName}" was disabled`;
    } else {
        warningMessage = 'Are you sure you want to disable multiple blocks?';
        const re = RegExp(blockName);
        existingBlocks.forEach(block => {
            if (re.test(block)) {
                detailMessage.push(`"${block}"`);
            }
        });
        successMessage = 'Matching blocks were disabled: ', detailMessage.join(', ');
        detailMessage.unshift('The following blocks will be disabled:');
    }
    const confirm = await window.showWarningMessage(
        warningMessage, { detail: detailMessage.join('\n- '), modal: true }, 'Yes');
    if (confirm === 'Yes') {
        const result = await execModtool('disable', blockName);
        if (result instanceof PythonShellError) {
            throw new ModtoolError(result.log ?? result.message);
        }
        return window.showInformationMessage(successMessage);
    }
}

/**
 * Remove the block from the OOT module.
 * 
 * This command runs `gr_modtool rm %f`, removing all related files and changing CMakeLists.
 */
export async function removeBlock(execModtool: ModtoolClosure, cwd: string, moduleName: string, blockName?: string) {
    const existingBlocks = blocks.getAllBlocks(cwd, moduleName);
    if (!blockName) {
        blockName = window.activeTextEditor?.document.fileName;
        if (blockName) {
            blockName = blocks.filteredMapBlockFile(blockName, moduleName);
        }
        blockName = await quickPickWithRegex(
            Array.from(existingBlocks), {
            title: 'GNURadio: Remove Blocks',
            placeholder: 'Enter block name or regular expression...',
            value: blockName,
        });
        if (!blockName) {
            return;
        }
    }
    let warningMessage: string;
    let successMessage: string;
    let detailMessage: string[] = [];
    if (existingBlocks.has(blockName)) {
        warningMessage = `Are you sure you want to remove "${blockName}"?`;
        successMessage = `Block "${blockName}" was removed`;
        detailMessage = (await getBlockFilesTree(blockName, Uri.file(cwd), moduleName))
            .map(item => item.resourceUri!.fsPath.slice(cwd.length + 1));
        detailMessage.unshift('The following files will be deleted:');
    } else {
        warningMessage = `Are you sure you want to remove multiple blocks?`;
        const re = RegExp(blockName);
        existingBlocks.forEach(block => {
            if (re.test(block)) {
                detailMessage.push(`"${block}"`);
            }
        });
        successMessage = 'Matching blocks were removed: ' + detailMessage.join(', ');
        detailMessage.unshift('The following blocks will be removed:');
    }
    const confirm = await window.showWarningMessage(
        warningMessage, { detail: detailMessage.join('\n- '), modal: true }, 'Yes');
    if (confirm === 'Yes') {
        const result = await execModtool('rm', blockName);
        if (result instanceof PythonShellError) {
            throw new ModtoolError(result.log ?? result.message);
        }
        return window.showInformationMessage(successMessage);
    }
}

/**
 * Change the block's name.
 * 
 * This command runs `gr_modtool rename %f`, renaming all related files and changing CMakeLists.
 */
export async function renameBlock(execModtool: ModtoolClosure, cwd: string, moduleName: string, blockName?: string) {
    const existingBlocks = blocks.getAllBlocks(cwd, moduleName);
    if (!blockName) {
        blockName = window.activeTextEditor?.document.fileName;
        if (blockName) {
            blockName = blocks.filteredMapBlockFile(blockName, moduleName);
        }
        blockName = await quickPick(
            Array.from(existingBlocks), {
            title: 'GNURadio: Rename Block',
            placeholder: 'Enter block name...',
            value: blockName,
        });
        if (!blockName) {
            return;
        }
    }
    const newBlockName = await window.showInputBox({
        title: `GNURadio: Rename "${blockName}"`,
        placeHolder: 'Enter new block name...',
        validateInput: validateBlockName(existingBlocks),
    });
    if (!newBlockName) {
        return;
    }
    let blockFiles = (await getBlockFilesTree(blockName, Uri.file(cwd), moduleName))
        .map(item => item.resourceUri!.fsPath.slice(cwd.length + 1));
    blockFiles.unshift('The following files will be renamed:');
    const confirm = await window.showWarningMessage(
        `Are you sure you want to rename "${blockName}" to "${newBlockName}"?`,
        { detail: blockFiles.join('\n- '), modal: true },
        'Yes');
    if (confirm === 'Yes') {
        const result = await execModtool('rename', blockName, newBlockName);
        if (result instanceof PythonShellError) {
            throw new ModtoolError(result.log ?? result.message);
        }
        return window.showInformationMessage(`Block "${blockName}" was renamed to "${newBlockName}"`);
    }
}

export function quickPick(
    items: string[], options: {
        title?: string,
        placeholder?: string,
        value?: string,
        onDidChangeValue?: (e: string) => any,
        onDidAccept?: (e: void) => any,
    } = {}) {
    return new Promise<string>((resolve) => {
        let blockPick = window.createQuickPick();
        blockPick.title = options.title;
        blockPick.placeholder = options.placeholder;
        blockPick.items = items.map((label) => ({ label }));
        blockPick.value = options.value ?? '';
        if (options.onDidChangeValue) {
            blockPick.onDidChangeValue(options.onDidChangeValue);
        }
        if (!options.onDidAccept) {
            options.onDidAccept = () => {
                resolve(blockPick.selectedItems[0].label);
                blockPick.hide();
            };
        }
        blockPick.onDidAccept(options.onDidAccept);
        blockPick.onDidHide(() => blockPick.dispose());
        blockPick.show();
    });
}

export function quickPickWithRegex(
    items: string[], options: {
        title?: string,
        placeholder?: string,
        value?: string,
    } = {}) {
    return new Promise<string>((resolve) => {
        let blockPick = window.createQuickPick();
        blockPick.title = options.title;
        blockPick.placeholder = options.placeholder;
        blockPick.canSelectMany = false;
        blockPick.items = items.map((label) => ({ label }));
        blockPick.value = options.value ?? '';
        blockPick.onDidChangeValue(() => {
            if (!items.includes(blockPick.value)) {
                let picks: QuickPickItem[] = items.map((label) => ({ label }));
                let regexPick = {
                    label: blockPick.value,
                    description: 'Regular expression',
                    iconPath: new ThemeIcon('filter'),
                };
                if (items.includes(blockPick.value)) {
                    picks.push(regexPick);
                } else {
                    picks.unshift(regexPick);
                }
                blockPick.items = picks;
            }
        });
        blockPick.onDidAccept(() => {
            const selection = blockPick.selectedItems[0];
            if (selection.description === 'Regular expression') {
                // TODO: regex syntax
                resolve(`.*${selection.label}.*`);
            } else {
                resolve(selection.label);
            }
            blockPick.hide();
        });
        blockPick.onDidHide(() => blockPick.dispose());
        blockPick.show();
    });
}
