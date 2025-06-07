import { addWeeks, startOfWeek, format } from 'date-fns';

interface SprintInfo {
    sprintNumber: number;
    startDate: Date;
}

export function calculateCurrentSprint(projectStartDate: string): { sprintNumber: number; startDate: Date } {
    const today = new Date();
    const startDate = new Date(projectStartDate);
    
    // Bereken het aantal weken tussen de startdatum en vandaag
    const weeksDiff = Math.floor((today.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
    
    // Bereken het sprint nummer (elke 2 weken een nieuwe sprint)
    const sprintNumber = Math.floor(weeksDiff / 2) + 1;
    
    // Bereken de startdatum van de huidige sprint
    const sprintStartDate = new Date(startDate);
    sprintStartDate.setDate(startDate.getDate() + (sprintNumber - 1) * 14); // 14 dagen per sprint
    
    return {
        sprintNumber,
        startDate: sprintStartDate
    };
} 