// Test script om sprint berekening te controleren
const projectStartDate = new Date('2025-05-11T22:00:00.000Z'); // 12-5-2025
const dueDate = new Date('2026-01-04'); // 4-1-2026
const currentDate = new Date('2025-06-19');

console.log('Project start datum:', projectStartDate.toLocaleDateString('nl-NL'));
console.log('Due date ATL7Q2-304:', dueDate.toLocaleDateString('nl-NL'));
console.log('Huidige datum:', currentDate.toLocaleDateString('nl-NL'));

// Bereken sprint datums
const sprintDates = {};
for (let i = 1; i <= 100; i++) {
    const sprintStartDate = new Date(projectStartDate);
    sprintStartDate.setDate(projectStartDate.getDate() + ((i - 1) * 14));
    const sprintEndDate = new Date(sprintStartDate);
    sprintEndDate.setDate(sprintStartDate.getDate() + 13);
    sprintDates[i] = {
        start: sprintStartDate,
        end: sprintEndDate
    };
}

// Zoek huidige sprint
let currentSprint = 0;
for (let i = 1; i <= 100; i++) {
    if (currentDate >= sprintDates[i].start && currentDate <= sprintDates[i].end) {
        currentSprint = i;
        break;
    }
}

// Zoek due date sprint
let dueDateSprint = 0;
for (let i = 1; i <= 100; i++) {
    if (dueDate >= sprintDates[i].start && dueDate <= sprintDates[i].end) {
        dueDateSprint = i;
        break;
    }
}

console.log('\n=== RESULTATEN ===');
console.log(`Huidige sprint: ${currentSprint} (${sprintDates[currentSprint]?.start.toLocaleDateString('nl-NL')} - ${sprintDates[currentSprint]?.end.toLocaleDateString('nl-NL')})`);
console.log(`Due date sprint: ${dueDateSprint} (${sprintDates[dueDateSprint]?.start.toLocaleDateString('nl-NL')} - ${sprintDates[dueDateSprint]?.end.toLocaleDateString('nl-NL')})`);

// Controleer sprint 65
console.log(`\nSprint 65: ${sprintDates[65]?.start.toLocaleDateString('nl-NL')} - ${sprintDates[65]?.end.toLocaleDateString('nl-NL')}`);

// Test findSprintIndexForDate logica
function findSprintIndexForDate(date, projectStartDate) {
    const timeDiff = date.getTime() - projectStartDate.getTime();
    const daysDiff = Math.floor(timeDiff / (1000 * 3600 * 24));
    const sprintIndex = Math.floor(daysDiff / 14);
    return sprintIndex;
}

const calculatedSprintIndex = findSprintIndexForDate(dueDate, projectStartDate);
console.log(`\nBerekende sprint index voor due date: ${calculatedSprintIndex}`);
console.log(`Sprint nummer (index + 1): ${calculatedSprintIndex + 1}`);

// Simuleer de findSprintIndexForDate functie uit de code
function findSprintIndexForDateFromCode(date, sprintCapacities) {
    return sprintCapacities.findIndex(s => {
        if (!s.startDate) return false;
        const sprintStartDate = new Date(s.startDate);
        const sprintEndDate = new Date(sprintStartDate);
        sprintEndDate.setDate(sprintStartDate.getDate() + 14); // Sprint duurt 2 weken (14 dagen, inclusief begin- en einddatum)
        return date >= sprintStartDate && date <= sprintEndDate;
    });
}

// Maak een mock sprintCapacity array
const mockSprintCapacities = [];
for (let i = 1; i <= 100; i++) {
    const sprintStartDate = new Date(projectStartDate);
    sprintStartDate.setDate(projectStartDate.getDate() + ((i - 1) * 14));
    mockSprintCapacities.push({
        sprint: i.toString(),
        startDate: sprintStartDate.toISOString(),
        capacity: 100,
        employee: 'Test',
        project: 'Test'
    });
}

const codeSprintIndex = findSprintIndexForDateFromCode(dueDate, mockSprintCapacities);
console.log(`\n=== CODE SIMULATIE ===`);
console.log(`findSprintIndexForDate uit code: ${codeSprintIndex}`);
console.log(`Sprint nummer uit code: ${codeSprintIndex + 1}`);

// Toon sprint 65 details
console.log(`\n=== SPRINT 65 DETAILS ===`);
console.log(`Start: ${sprintDates[65]?.start.toLocaleDateString('nl-NL')}`);
console.log(`Eind: ${sprintDates[65]?.end.toLocaleDateString('nl-NL')}`);
console.log(`Due date valt in sprint 65: ${dueDate >= sprintDates[65]?.start && dueDate <= sprintDates[65]?.end}`);

// Toon sprints rond due date
console.log(`\n=== SPRINTS ROND DUE DATE ===`);
for (let i = 60; i <= 70; i++) {
    console.log(`Sprint ${i}: ${sprintDates[i]?.start.toLocaleDateString('nl-NL')} - ${sprintDates[i]?.end.toLocaleDateString('nl-NL')} `);
}

// Test findSprintIndexForDate
const dueDateSprintIndex = findSprintIndexForDate(dueDate, projectStartDate);
console.log(`Due date sprint index: ${dueDateSprintIndex}`);
if (dueDateSprintIndex !== -1) {
    console.log(`Due date sprint nummer: ${dueDateSprintIndex + 1}`);
}

// Test met andere project start datum
const alternativeStartDate = new Date('2025-01-01');
const alternativeDueDateSprint = findSprintIndexForDate(dueDate, alternativeStartDate);
console.log(`\n=== TEST MET ANDERE PROJECT START DATUM ===`);
console.log(`Alternative project start: ${alternativeStartDate.toLocaleDateString('nl-NL')}`);
console.log(`Due date sprint met alternative start: ${alternativeDueDateSprint}`);
console.log(`Alternative Sprint 65: ${sprintDates[65]?.start.toLocaleDateString('nl-NL')} - ${sprintDates[65]?.end.toLocaleDateString('nl-NL')}`);
console.log(`Due date valt in alternative sprint 65: ${dueDate >= sprintDates[65]?.start && dueDate <= sprintDates[65]?.end}`); 