const fs = require('fs');

const skipPatterns = [/UpdateTaskMachineCore/, /UpdateTaskMachineUA/, /S-\d+-\d+-\d+-\d{9}-\d{10}-\d{9}-\d{4}/];

let FileMatchesSkipPattern = (fileName) => {
    for (let skipPattern of skipPatterns) {
        if (skipPattern.test(fileName)) return true;
    }
    return false;
};

export let GetWindowsScheduledTasks = async (fnLogError: any) => {
    let tasks = [];
    const tasksDirectory = `${process.env.HOMEDRIVE}/Windows/System32/Tasks/`;
    return new Promise((resolve) => {
        fs.readdir(tasksDirectory, async (err, files: string[]) => {
            if (err) {
                fnLogError(`Error getting folder contents`, err.stack, {
                    method: 'GetWindowsScheduledTasks',
                    tasksDirectory,
                    error: err.toString(),
                });
            } else {
                try {
                    tasks = files
                        .filter((fileName) => {
                            const filePath = `${tasksDirectory}${fileName}`;
                            return !FileMatchesSkipPattern(fileName) && !fs.statSync(filePath).isDirectory();
                        })
                        .map((fileName) => {
                            const filePath = `${tasksDirectory}${fileName}`;
                            return fs.readFileSync(filePath).toString('utf16le');
                        });
                    resolve(tasks);
                } catch (e) {
                    fnLogError('Error getting scheduled tasks', e.stack, {
                        method: 'GetWindowsScheduledTasks',
                        error: e.toString(),
                    });
                }
            }
        });
    });
};
