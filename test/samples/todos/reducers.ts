import { AnyAction } from 'redux';

type Todo = {
  id: number;
  text?: string;
  completed?: boolean;
}

export default function todos(state: Todo[] = [], action: AnyAction): Todo[] {
  //console.log(`reducers:todos: state=${JSON.stringify(state)}; action=${JSON.stringify(action)}`);
  switch (action.type) {
    case 'ADD_TODO':
      return [
        ...state,
        {
          id: state.length+1,
          text: action.text,
          completed: false
        }
      ];
    case 'TOGGLE_TODO':
      //console.log(` case TOGGLE_TODO: state(ret)=${JSON.stringify(state.map(todo => todo.id === action.id ? { ...todo, completed: !todo.completed } : todo))}`);
      return state.map(todo =>
        todo.id === action.id ? { ...todo, completed: !todo.completed } : todo
      );
    default:
      return state;
  }
}
